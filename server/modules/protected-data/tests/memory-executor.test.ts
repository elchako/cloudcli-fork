import assert from 'node:assert/strict';
import { randomUUID, webcrypto } from 'node:crypto';
import test from 'node:test';

import { protectedDataAad, type ProtectedDataEnvelope, type ProtectedDataProfile } from '../protocol.js';
import { createProtectedDataRelay } from '../relay.js';

const marker = 'synthetic-memory-check';

async function seal(profile: ProtectedDataProfile, issuedAt: number): Promise<ProtectedDataEnvelope> {
  const meta = { version: 1 as const, revision: profile.revision, sessionId: 'session-memory', nonce: randomUUID(), issuedAt, names: ['TOKEN'] };
  const { subtle } = webcrypto;
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const contentKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const publicKey = await subtle.importKey('spki', Buffer.from(profile.publicKey, 'base64'),
    { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['wrapKey']);
  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: protectedDataAad(meta) },
    contentKey, Buffer.from(JSON.stringify([marker])));
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
