import assert from 'node:assert/strict';
import { randomUUID, webcrypto } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { applyToReceiver, readApplyReceiver } from '../apply-receiver.js';
import { createMemoryProtectedDataExecutor } from '../executor.js';
import { protectedDataAad, type ProtectedDataEnvelope, type ProtectedDataProfile } from '../protocol.js';
import { createProtectedDataRelay } from '../relay.js';

const marker = 'synthetic-memory-check';

async function seal(profile: ProtectedDataProfile, issuedAt: number, names = ['TOKEN'], values = [marker]): Promise<ProtectedDataEnvelope> {
  const meta = { version: 1 as const, revision: profile.revision, sessionId: 'session-memory', nonce: randomUUID(), issuedAt, names };
  const { subtle } = webcrypto;
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const contentKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const publicKey = await subtle.importKey('spki', Buffer.from(profile.publicKey, 'base64'),
    { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['wrapKey']);
  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: protectedDataAad(meta) },
    contentKey, Buffer.from(JSON.stringify(values)));
  const wrappedKey = await subtle.wrapKey('raw', contentKey, publicKey, 'RSA-OAEP');
  return { ...meta, wrappedKey: Buffer.from(wrappedKey).toString('base64'), iv: Buffer.from(iv).toString('base64'), ciphertext: Buffer.from(ciphertext).toString('base64') };
}

test('встроенный исполнитель принимает только конверт, действует один раз и истекает ровно через 30 минут', async () => {
  const sentAt = Date.now();
  let clock = sentAt;
  let outsideCalls = 0;
  const relay = createProtectedDataRelay({
    mode: 'memory', now: () => clock,
    call: async () => { outsideCalls++; throw new Error('режим памяти не должен ходить к сокету'); },
    pinnedKey: () => { outsideCalls++; return undefined; },
  });
  const profile = await relay.getProfile();
  assert.equal(profile?.operation, 'local-check');
  assert.deepEqual(profile.requiredFields, []);
  const envelope = await seal(profile, sentAt);
  assert.ok(!JSON.stringify(envelope).includes(marker));
  const unused = await seal(profile, sentAt);
  const id = await relay.stage('user', envelope);
  const unusedId = await relay.stage('user', unused);
  assert.ok(id && unusedId);
  assert.equal(relay.prepare('other user', envelope.sessionId, id), null);
  assert.equal(relay.prepare('user', 'other session', id), null);
  const writer = { send: () => {} };
  assert.equal(relay.prepare('user', envelope.sessionId, id)?.(writer), true);
  const grant = relay.take(writer);
  assert.equal(grant?.operation, 'local-check');
  assert.equal(relay.take(writer), undefined);

  clock = sentAt + 30 * 60_000 - 1;
  assert.equal(relay.isActive(writer), true);
  assert.equal(await relay.execute(grant.envelope), 'received');
  assert.equal(await relay.execute(grant.envelope), 'used');
  clock += 1;
  assert.equal(relay.isActive(writer), false);
  assert.equal(relay.prepare('user', unused.sessionId, unusedId), null);
  assert.equal(await relay.execute(unused), 'expired');
  assert.equal(outsideCalls, 0);
});

test('после нового запуска старые конверты недействительны: ключ и ревизия в памяти новые', async () => {
  const first = createProtectedDataRelay({ mode: 'memory' });
  const profile = await first.getProfile();
  assert.ok(profile);
  const envelope = await seal(profile, Date.now());
  const second = createProtectedDataRelay({ mode: 'memory' });
  const restarted = await second.getProfile();
  assert.ok(restarted);
  assert.notEqual(restarted.publicKey, profile.publicKey);
  assert.notEqual(restarted.revision, profile.revision);
  assert.equal(await second.stage('user', envelope), null);
  assert.equal(await second.execute(envelope), 'invalid');
});

test('получатель получает только выбранное значение в stdin, не в аргументах или окружении', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cloudcli-receiver-fixture-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const program = join(dir, 'receive.mjs');
  const output = join(dir, 'expected.txt');
  const config = join(dir, 'receiver.json');
  await writeFile(program, [
    'import { readFileSync, writeFileSync } from "node:fs";',
    'const value = readFileSync(0, "utf8");',
    'if ([...process.argv, ...Object.values(process.env)].some(s => s?.includes(value))) process.exit(4);',
    'writeFileSync(process.argv[2], value, { mode: 0o600 });',
    'console.log(value);',
  ].join('\n'));
  await writeFile(config, JSON.stringify({ label: 'Тестовый получатель', field: 'TOKEN', executable: process.execPath, args: [program, output] }), { mode: 0o600 });
  const receiver = readApplyReceiver(config);
  assert.ok(receiver);
  const executor = createMemoryProtectedDataExecutor(Date.now, receiver);
  assert.equal(executor.profile.operation, 'apply');
  assert.deepEqual(executor.profile.requiredFields, ['TOKEN']);
  assert.ok(!JSON.stringify(executor.profile).includes(program));
  const invalid = await seal(executor.profile, Date.now(), ['WRONG'], [marker]);
  assert.equal(await executor.execute(invalid), 'invalid');
  const cancelled = AbortSignal.abort();
  assert.equal(await applyToReceiver(receiver, marker, cancelled), false);
  await assert.rejects(readFile(output));

  const valid = await seal(executor.profile, Date.now(), ['TOKEN', 'OTHER'], [marker, 'synthetic-unselected']);
  assert.equal(await executor.execute(valid), 'applied');
  assert.equal(await readFile(output, 'utf8'), marker);
  await writeFile(output, 'changed externally');
  assert.equal(await executor.execute(valid), 'used');
  assert.equal(await readFile(output, 'utf8'), 'changed externally');
});
