import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import test from 'node:test';

import { createProtectedDataRelay } from '../relay.js';
import { PROTECTED_DATA_TTL_MS, type ProtectedDataEnvelope } from '../protocol.js';

const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' });
const pin = createHash('sha256').update(key).digest('hex');
const profile = { revision: 'a'.repeat(64), label: 'Проверка API', publicKey: key.toString('base64'), requiredFields: ['TOKEN'] };

function fixture() {
  let now = Date.now();
  const envelope: ProtectedDataEnvelope = {
    version: 1,
    revision: profile.revision,
    issuedAt: now,
    sessionId: 'session-a',
    nonce: randomUUID(),
    names: ['TOKEN'],
    ciphertext: Buffer.alloc(20, 1).toString('base64'),
    wrappedKey: Buffer.alloc(256, 2).toString('base64'),
    iv: Buffer.alloc(12, 3).toString('base64'),
  };
  let executions = 0;
  let activePin = pin;
  const relay = createProtectedDataRelay({
    now: () => now,
    pinnedKey: () => activePin,
    call: async (route) => {
      if (route === '/v1/profile') return profile;
      executions++;
      return { status: 'unrecognized', extra: 'private-output-marker' };
    },
  });
  return {
    relay, envelope,
    changePin: () => { activePin = 'b'.repeat(64); },
    expire: () => { now += PROTECTED_DATA_TTL_MS; },
    executions: () => executions,
  };
}

test('нельзя получить набор другого пользователя или сеанса; ID назначает ровно один writer', async () => {
  const { relay, envelope } = fixture();
  const id = await relay.stage('user-a', envelope);
  assert.ok(id);
  assert.equal(relay.prepare('user-b', envelope.sessionId, id), null);
  assert.equal(relay.prepare('user-a', 'session-b', id), null);

  const a = { send: () => {} };
  const b = { send: () => {} };
  const first = relay.prepare('user-a', envelope.sessionId, id);
  const racing = relay.prepare('user-a', envelope.sessionId, id);
  assert.equal(first?.(a), true);
  assert.equal(racing?.(b), false);
  assert.equal(relay.take(b), undefined);
  assert.equal(relay.take(a), envelope);
  assert.equal(relay.take(a), undefined);
  assert.equal(relay.prepare('user-a', envelope.sessionId, id), null);
  assert.equal(await relay.stage('user-a', envelope), null, 'неиспользованный конверт нельзя заново привязать');
});

test('отзыв при остановке действует даже до запуска SDK', async () => {
  const { relay, envelope } = fixture();
  const id = await relay.stage('user-a', envelope);
  const writer = { send: () => {} };
  assert.equal(relay.prepare('user-a', envelope.sessionId, id)?.(writer), true);
  assert.equal(relay.isActive(writer), true);
  relay.forget(writer);
  assert.equal(relay.wasBound(writer), true);
  assert.equal(relay.isActive(writer), false);
  assert.equal(relay.take(writer), undefined);
  assert.equal(await relay.stage('user-a', envelope), null);
});

test('не совпадающий PIN, старый профиль и просроченный набор не принимаются', async () => {
  const { relay, envelope, changePin, expire, executions } = fixture();
  assert.equal(await relay.stage('user-a', { ...envelope, revision: 'b'.repeat(64) }), null);
  assert.equal(await relay.stage('user-a', { ...envelope, names: ['URL'] }), null);
  const id = await relay.stage('user-a', envelope);
  assert.ok(id);
  changePin();
  assert.equal(await relay.getProfile(), null);
  assert.equal(await relay.stage('user-a', envelope), null);
  expire();
  assert.equal(relay.prepare('user-a', envelope.sessionId, id), null);
  assert.equal(await relay.execute(envelope), 'expired');
  assert.equal(executions(), 0);
});

test('неожиданный ответ исполнителя не попадает в результат проверки', async () => {
  const { relay, envelope, executions } = fixture();
  assert.equal(await relay.execute(envelope), 'failed');
  assert.equal(executions(), 1);
});
