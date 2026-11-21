import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { updateEnvText, writeProtectedEnvEntry } from '../env-file-writer.js';

const original = '# Настройки\r\nUNCHANGED=keep\r\nSERVICE_API_KEY=old\r\n';

test('EnvironmentFile: заменяется одна переменная, формат и остальные строки сохраняются', () => {
  assert.equal(updateEnvText(original, 'SERVICE_API_KEY', 'demo $token"\\value'),
    '# Настройки\r\nUNCHANGED=keep\r\nSERVICE_API_KEY="demo \\$token\\\"\\\\value"\r\n');
  assert.equal(updateEnvText('A=1\n', 'B', 'fixture'), 'A=1\nB="fixture"\n');
  assert.throws(() => updateEnvText('A=1\nA=2\n', 'A', 'fixture'));
  assert.throws(() => updateEnvText('A="line 1\nB=part of A\n"\n', 'B', 'fixture'));
  assert.throws(() => updateEnvText('A=1\n', 'A', 'x\nB=unexpected'));
});

test('одинаковые владелец, группа и 0640; символические ссылки и открытые файлы отклоняются', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cloudcli-env-fixture-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'test.env');
  await writeFile(path, original, { mode: 0o640 });
  await chmod(path, 0o640);
  const initial = await stat(path);
  await writeProtectedEnvEntry(path, 'SERVICE_API_KEY', 'synthetic-token');
  const after = await stat(path);
  assert.deepEqual([after.uid, after.gid, after.mode], [initial.uid, initial.gid, initial.mode]);
  const expected = original.replace('SERVICE_API_KEY=old', 'SERVICE_API_KEY="synthetic-token"');
  assert.equal(await readFile(path, 'utf8'), expected);
  assert.deepEqual(await readdir(dir), ['test.env']);
  const link = join(dir, 'link.env');
  await symlink(path, link);
  await assert.rejects(writeProtectedEnvEntry(link, 'SERVICE_API_KEY', 'new-fixture'));
  await chmod(path, 0o644);
  await assert.rejects(writeProtectedEnvEntry(path, 'SERVICE_API_KEY', 'new-fixture'));
  assert.equal(await readFile(path, 'utf8'), expected);
});
