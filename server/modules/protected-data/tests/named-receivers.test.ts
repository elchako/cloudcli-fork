import assert from 'node:assert/strict';
import { constants, createCipheriv, createPublicKey, publicEncrypt, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { readApplyReceiver } from '../apply-receiver.js';
import { createMemoryProtectedDataExecutor } from '../executor.js';
import { protectedDataAad, readProtectedDataProfile, type ProtectedDataProfile } from '../protocol.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cloudcli-targets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'targets.json');
  const write = (value: unknown) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
  return { directory, path, write };
}

const pairs = [['SECOND', 'проверка\n"\\'], ['__proto__', 'synthetic-value']];
function seal(profile: ProtectedDataProfile, target?: string) {
  const meta = { version: 1 as const, revision: profile.revision, sessionId: 'test-targets', nonce: randomUUID(),
    issuedAt: Date.now(), names: pairs.map(([name]) => name), ...(target === undefined ? {} : { target }) };
  const iv = randomBytes(12);
  const key = randomBytes(32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(protectedDataAad(meta));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(pairs.map(([, value]) => value))), cipher.final(), cipher.getAuthTag()]);
  const publicKey = createPublicKey({ key: Buffer.from(profile.publicKey, 'base64'), format: 'der', type: 'spki' });
  const wrappedKey = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  return { ...meta, iv: iv.toString('base64'), wrappedKey: wrappedKey.toString('base64'), ciphertext: ciphertext.toString('base64') };
}

test('каталог принимает 1–16 получателей и отклоняет конфигурацию целиком при ошибке любого из них', async (t) => {
  const { directory, path, write } = await fixture(t);
  const target = { id: 'a-1_2', label: 'Служба', executable: process.execPath, args: [] };
  const limit = Array.from({ length: 16 }, (_, i) => ({ ...target, id: `t${i}` }));
  await write({ targets: limit });
  const config = readApplyReceiver(path);
  assert.ok(config && 'targets' in config);
  assert.deepEqual(config.targets.map(({ id }) => id), limit.map(({ id }) => id));
  const badExec = join(directory, 'unsafe');
  await writeFile(badExec, 'test');
  for (const mode of [0o600, 0o777, 0o4755]) {
    await chmod(badExec, mode);
    await write({ targets: [{ ...target, executable: badExec }] });
    assert.throws(() => readApplyReceiver(path));
  }
  for (const bad of [[], {}, { targets: [] }, { targets: [target, target] }, { targets: [target, ...limit] },
    { targets: [target], field: 'KEY' }, { targets: [target, null] }, { targets: [target, { id: 'b' }] },
    ...['id\n', 'A', '0', '../path', 'a'.repeat(33), 'delivery-check', 'project-env', 'chat-destination'].map(id => ({ targets: [{ ...target, id }] })),
    ...[{ label: ' ' }, { field: 'KEY' }, { executable: 'relative' }, { args: 'arg' }, { args: ['a\nb'] },
      { args: [8] }, { args: Array(17).fill('a') }, { args: ['a'.repeat(4097)] }].map(patch => ({ targets: [{ ...target, ...patch }] })),
  ]) {
    await write(bad);
    assert.throws(() => readApplyReceiver(path));
  }
  await write({ targets: [target] });
  await chmod(path, 0o640);
  assert.throws(() => readApplyReceiver(path));
  await chmod(path, 0o600);
  const link = join(directory, 'link');
  await symlink(path, link);
  assert.throws(() => readApplyReceiver(link));
});

test('только аутентифицированная цель получает все пары единым JSON в stdin; вывод процесса отключён', async (t) => {
  const { directory, path, write } = await fixture(t);
  const program = join(directory, 'receiver.cjs');
  const output = join(directory, 'receipt');
  await writeFile(program, [
    'const fs = require("node:fs");',
    'const [output, role] = process.argv.slice(2);',
    'const input = fs.readFileSync(0, "utf8");',
    'const values = JSON.parse(input).map(([, value]) => value);',
    'if (values.some(v => [...process.argv, ...Object.values(process.env)].some(s => s.includes(v)))) process.exit(2);',
    'const dev = fs.statSync("/dev/null");',
    'if (![1, 2].every(fd => { const s = fs.fstatSync(fd); return s.isCharacterDevice() && s.rdev === dev.rdev; })) process.exit(3);',
    'fs.appendFileSync(output, JSON.stringify([role, input]) + "\\n", { mode: 0o600 });',
    'process.exitCode = role === "first" ? 1 : 0;',
  ].join('\n'));
  const targets = ['first', 'second'].map(id => ({ id, label: `Служба ${id}`, executable: process.execPath, args: [program, output, id] }));
  await write({ targets });
  const executor = createMemoryProtectedDataExecutor(Date.now, readApplyReceiver(path), true);
  const { profile } = executor;
  assert.deepEqual(readProtectedDataProfile(profile), profile);
  assert.equal(profile.operation, 'env-apply');
  assert.deepEqual(profile.requiredFields, []);
  assert.deepEqual(profile.targets, targets.map(({ id, label }) => ({ id, label })));
  const valid = seal(profile, 'second');
  for (const target of [undefined, 'unknown', 'project-env', 'delivery-check']) {
    assert.equal(await executor.execute(seal(profile, target), directory), 'invalid');
  }
  assert.equal(await executor.execute({ ...valid, target: 'first' }), 'invalid');
  await assert.rejects(readFile(output), { code: 'ENOENT' });
  assert.equal(await executor.execute(valid), 'applied');
  assert.equal(await executor.execute(valid), 'used');
  const failing = seal(profile, 'first');
  assert.equal(await executor.execute(failing), 'failed');
  assert.equal(await executor.execute(failing), 'used');
  assert.deepEqual((await readFile(output, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line)),
    ['second', 'first'].map(role => [role, JSON.stringify(pairs)]));
});

test('встроенные цели доступны только в режиме проекта, запись требует серверного корня', async () => {
  const legacy = createMemoryProtectedDataExecutor();
  assert.equal(legacy.profile.operation, 'local-check');
  assert.equal(await legacy.execute(seal(legacy.profile, 'project-env')), 'invalid');
  const executor = createMemoryProtectedDataExecutor(Date.now, undefined, true);
  assert.deepEqual(executor.profile.targets, [
    { id: 'chat-destination', label: 'По заданию в чате' },
    { id: 'project-env', label: 'Текущий проект · .env' }, { id: 'delivery-check', label: 'Только проверить доставку' },
  ]);
  assert.equal(await executor.execute(seal(executor.profile)), 'invalid');
  assert.equal(await executor.execute(seal(executor.profile, 'project-env')), 'invalid');
  assert.equal(await executor.execute({ ...seal(executor.profile, 'project-env'), projectRoot: '/tmp' }), 'invalid');
  const delivery = seal(executor.profile, 'delivery-check');
  assert.equal(await executor.execute(delivery), 'received');
  assert.equal(await executor.execute(delivery), 'used');
});
