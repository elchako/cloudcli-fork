import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { writeProtectedEnvEntries } from '../env-file-writer.js';
import { PROTECTED_DATA_MAX_BODY_BYTES, PROTECTED_DATA_MAX_FIELDS, PROTECTED_DATA_MAX_VALUE_BYTES } from '../protocol.js';

async function fixture(t: TestContext, text: string) {
  const dir = await mkdtemp(join(tmpdir(), 'cloudcli-env-batch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'test.env');
  await writeFile(path, text, { mode: 0o600 });
  return { dir, path };
}

test('Map: замена и добавление в одном новом файле, открытый дескриптор видит старый целиком', async (t) => {
  const original = '# настройки\r\nPORT=80\r\nKEEP=original\r\nHOST=old';
  const { path } = await fixture(t, original);
  const previous = await open(path, 'r');
  try {
    await writeProtectedEnvEntries(path, new Map([['HOST', 'новый'], ['TOKEN', 'a$b'], ['PORT', '81']]));
    assert.equal(await readFile(path, 'utf8'), '# настройки\r\nPORT="81"\r\nKEEP=original\r\nHOST="новый"\r\nTOKEN="a\\$b"\r\n');
    assert.notEqual((await stat(path)).ino, (await previous.stat()).ino);
    assert.equal(await previous.readFile('utf8'), original);
  } finally { await previous.close(); }
});

test('Map: ошибка позднего поля или превышение общего размера не меняют исходный файл', async (t) => {
  const original = 'A=old\nB=one\nB=two\n';
  const { path, dir } = await fixture(t, original);
  const inode = (await stat(path)).ino;
  const maxFields = Array.from({ length: PROTECTED_DATA_MAX_FIELDS }, (_, i): [string, string] => [`F${i}`, 'x']);
  const rejected: [string, string][][] = [
    [], [...maxFields, ['EXTRA', 'x']], [['A', 'new'], ['B', 'ambiguous']],
    [['A', 'new'], ['bad-name', 'x']], [['A', 'new'], ['C', 'a\nb']],
    [['A', 'new'], ['C', 'я'.repeat(PROTECTED_DATA_MAX_VALUE_BYTES / 2 + 1)]],
    maxFields.map(([key]) => [key, '$'.repeat(PROTECTED_DATA_MAX_VALUE_BYTES)]),
  ];
  for (const entries of rejected) {
    await assert.rejects(writeProtectedEnvEntries(path, new Map(entries)));
    assert.equal((await stat(path)).ino, inode);
    assert.equal(await readFile(path, 'utf8'), original);
    assert.deepEqual(await readdir(dir), ['test.env']);
  }
  await writeProtectedEnvEntries(path, new Map(maxFields));
  assert.equal(await readFile(path, 'utf8'), original + maxFields.map(([key]) => `${key}="x"\n`).join(''));
});

test('CLI: пакет из stdin, тихий отказ без частичной записи и старый одноимённый режим', async (t) => {
  const { dir, path } = await fixture(t, 'A=old\n');
  const main = fileURLToPath(new URL('../env-file-writer-main.ts', import.meta.url));
  function run(args: string[], input: string | Buffer, code: number) {
    const child = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), main, ...args], {
      cwd: dir, input, encoding: 'utf8', timeout: 10_000,
      env: { PATH: process.env.PATH, HOME: dir, DATABASE_PATH: join(dir, 'auth.db'), SSH_ORIGINAL_COMMAND: 'ignored' },
    });
    assert.ifError(child.error);
    assert.deepEqual([child.status, child.stdout, child.stderr], [code, '', '']);
  }
  run([path], '[["A","новый"],["B","2"]]', 0);
  const expected = 'A="новый"\nB="2"\n';
  assert.equal(await readFile(path, 'utf8'), expected);
  const inode = (await stat(path)).ino;
  for (const input of [
    '[["A","partial"],["B","bad\\nvalue"]]', '[["A","1"],["A","2"]]',
    '[', '{}', '[["A","1","extra"]]', '[["A",1]]', Buffer.from([0xff]),
    '[["A","1"]]' + ' '.repeat(PROTECTED_DATA_MAX_BODY_BYTES),
  ]) {
    run([path], input, 1);
  }
  run(['test.env'], '[["A","1"]]', 1);
  assert.equal((await stat(path)).ino, inode);
  assert.equal(await readFile(path, 'utf8'), expected);
  run([path, 'A'], 'legacy', 0);
  assert.equal(await readFile(path, 'utf8'), 'A="legacy"\nB="2"\n');
});
