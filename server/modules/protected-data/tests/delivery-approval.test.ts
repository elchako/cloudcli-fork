import assert from 'node:assert/strict';
import test from 'node:test';

import type { WebSocket } from 'ws';

import { authenticatedDeliveryChannel, deliveryConfirmationFor, revokeDeliveryApproval } from '../delivery-approval.js';

const sessionId = 'session';
const destination = 'Файл: /test/project/.env';
function setup(expiresAt = Date.now() + 30_000) {
  const writer = { userId: 3, send() {} };
  const channel = authenticatedDeliveryChannel({ readyState: 1, send() {} } as unknown as WebSocket, 3);
  channel.bind(writer, sessionId, () => true);
  const confirm = deliveryConfirmationFor(writer, () => true, expiresAt);
  const signal = new AbortController();
  const approve = () => channel.receive({ type: 'chat.protected-delivery-decision', sessionId,
    requestId: channel.pendingFor(sessionId)[0]?.requestId, allow: true }, true);
  return { writer, channel, confirm, approve, signal };
}

test('регистрация одноразова; незарегистрированный writer, скрытый символ и отмена до показа не дают права', async () => {
  const orphan = deliveryConfirmationFor({ send() {} }, () => true, Date.now() + 30_000);
  assert.equal(await orphan(destination, ['FIELD'], new AbortController().signal), false);
  for (const [preview, signal] of [[destination + '‮', new AbortController().signal], [destination, AbortSignal.abort()]] as const) {
    const s = setup();
    assert.equal(await s.confirm(preview, ['FIELD'], signal), false);
    assert.deepEqual(s.channel.pendingFor(sessionId), []);
  }
  const s = setup();
  const names = ['OLD'];
  const pending = s.confirm(destination, names, s.signal.signal);
  names[0] = 'NEW';
  assert.deepEqual(s.channel.pendingFor(sessionId)[0]?.input.names, ['OLD']);
  assert.equal(await s.confirm(destination, names, s.signal.signal), false);
  s.approve();
  assert.equal(await pending, true);
  assert.deepEqual(s.channel.pendingFor(sessionId), []);
});

test('отзыв, abort и истёкший grant между показом и ответом дают false', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  for (const reason of ['revoke', 'abort', 'expire', 'after-click']) {
    const s = setup(now + 1000);
    const result = s.confirm(destination, ['FIELD'], s.signal.signal);
    if (reason === 'revoke') revokeDeliveryApproval(s.writer);
    if (reason === 'abort') s.signal.abort();
    if (reason === 'expire') now += 1000; // Таймер ещё не получил управление.
    s.approve();
    if (reason === 'after-click') revokeDeliveryApproval(s.writer);
    assert.equal(await result, false, reason);
    assert.deepEqual(s.channel.pendingFor(sessionId), []);
  }
});

test('без ответа таймер сам завершает ожидание отказом', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const s = setup(Date.now() + 999_999);
  const pending = s.confirm(destination, ['FIELD'], s.signal.signal);
  t.mock.timers.tick(180_000);
  assert.equal(await pending, false);
  assert.deepEqual(s.channel.pendingFor(sessionId), []);
});
