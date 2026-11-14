import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign, verify } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import type { ElicitationRequest } from '@anthropic-ai/claude-agent-sdk';

import { LocalMailApproval, canonicalMailJson, mailSigningBytes, MAIL_APPROVAL_PREFIX } from '../index.js';

const root = mkdtempSync(path.join(tmpdir(), 'mail-approval-unit-'));
const issuer = generateKeyPairSync('ed25519');
const human = generateKeyPairSync('ed25519');
const privatePath = path.join(root, 'human.pem');
const configPath = path.join(root, 'config.json');
writeFileSync(privatePath, human.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
const config = {
  private_key_path: privatePath, key_id: 'cloudcli-local-human',
  authorities: [{ tenant_id: 't', user_id: 'u', client_id: 'c', cloudcli_user_id: '7',
    challenge_public_keys: { issuer: issuer.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url') } }],
};
writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
test.after(() => rmSync(root, { recursive: true, force: true }));
const now = 1_800_000_000_000;
const preview = { from: 'sender@example.test', to: ['to@example.test'], cc: [], bcc: ['blind@example.test'],
  subject: 'Тема', body: '<b>не HTML</b>\n**не Markdown**\nКонец',
  attachments: [{ filename: 'файл.txt', size: 7, sha256: 'a'.repeat(64) }] };
function request(patch: Record<string, unknown> = {}, options: Partial<ElicitationRequest> = {}): ElicitationRequest {
  const payload = {
    version: 1, audience: 'cloudcli-local-mail', tenant_id: 't', user_id: 'u', client_id: 'c', draft_id: 'draft', revision: 2,
    preview, preview_hash: createHash('sha256').update(canonicalMailJson(preview)).digest('hex'), eml_sha256: 'b'.repeat(64),
    nonce: '0f33fcfe-f41c-4a57-b3dc-8f41b454e243', issued_at: now - 1000, expires_at: now + 120_000,
    ...patch,
  };
  const envelope = { payload, key_id: 'issuer', signature: sign(null, mailSigningBytes('local-approval-challenge', payload), issuer.privateKey).toString('base64url') };
  return { serverName: 'mail-local', mode: 'form', message: MAIL_APPROVAL_PREFIX + canonicalMailJson(envelope),
    requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean', title: 'Отправить это письмо', default: false } }, required: ['confirm'] }, ...options };
}
const approve = { allow: true, updatedInput: { confirm: true } };
const frame = (patch: Record<string, unknown> = {}) => ({ type: 'chat.permission-response', sessionId: 'session', requestId: 'request', ...approve, ...patch });
const socket = { readyState: 1 };

test('canonical JSON совпадает с Python, включая Unicode, integer keys и порядок массивов', () => {
  const value = { '10': 'десять', '2': 'два', '\u{10000}': 1, '': 2, a: ['z', 'a'], nested: { z: null, a: true } };
  const python = spawnSync('python3', ['-I', '-c', 'import json,sys; print(json.dumps(json.load(sys.stdin),ensure_ascii=False,separators=(",",":"),sort_keys=True),end="")'], { input: JSON.stringify(value), encoding: 'utf8' });
  assert.equal(python.status, 0);
  assert.equal(canonicalMailJson(value), python.stdout);
  assert.throws(() => canonicalMailJson({ float: 1.5 }));
});

test('default off: подписант и регистрация выключены без конфигурации', () => {
  assert.equal(new LocalMailApproval().register(request(), 'request', 7, 'session'), null);
});

test('проверенный authenticated WS approve подписывает только исходный snapshot', () => {
  const service = new LocalMailApproval(configPath, () => now);
  const pending = service.register(request(), 'request', 7, 'session');
  assert.ok(pending);
  pending.input.localMailPreview.body = 'UI mutation';
  const receive = service.bindAuthenticatedConnection(socket as never, 7);
  assert.equal(receive(frame(), true), false);
  const result = pending.finish({ ...approve, updatedInput: { preview_hash: 'fake', draft_id: 'evil' } });
  assert.equal(result.action, 'accept');
  assert.equal(typeof result.content?.local_mail_decision, 'string');
  const envelope = JSON.parse(result.content!.local_mail_decision as string) as { payload: Record<string, unknown>; signature: string; key_id: string };
  assert.equal(envelope.key_id, 'cloudcli-local-human');
  assert.equal(envelope.payload.preview_hash, createHash('sha256').update(canonicalMailJson(preview)).digest('hex'));
  assert.equal(envelope.payload.draft_id, 'draft');
  assert.equal(envelope.payload.revision, 2);
  assert.equal(envelope.payload.cloudcli_user_id, '7');
  assert.equal(envelope.payload.conversation_id, 'session');
  assert.equal(envelope.payload.request_id, 'request');
  assert.equal(envelope.payload.channel, 'cloudcli_native');
  assert.equal(envelope.payload.expires_at, now + 60_000);
  assert.match(envelope.signature, /^[A-Za-z0-9_-]+==$/);
  assert.ok(verify(null, mailSigningBytes('local-human-decision', envelope.payload), human.publicKey, Buffer.from(envelope.signature, 'base64url')));
  assert.deepEqual(pending.finish(approve), { action: 'cancel' });
  assert.equal(service.register(request(), 'another-request', 7, 'session'), null);
});

for (const [name, patch] of Object.entries({
  expired: { expires_at: now }, future: { issued_at: now + 1 }, lifetime: { expires_at: now + 300_001 },
  reversed: { expires_at: now - 2000 }, hash: { preview_hash: 'c'.repeat(64) },
  audience: { audience: 'other' }, tenant: { tenant_id: 'foreign' }, user: { user_id: 'foreign' },
  client: { client_id: 'foreign' }, nonce: { nonce: 'not-a-uuid' }, revision: { revision: -1 },
})) {
  test(`не регистрируется challenge с нарушением ${name}`, () => {
    assert.equal(new LocalMailApproval(configPath, () => now).register(request(patch), 'request', 7, 'session'), null);
  });
}

test('поддельная подпись, неизвестный issuer и изменение signed draft отвергаются', () => {
  for (const mutate of [
    (e: Record<string, any>) => { e.signature = 'A'.repeat(86); },
    (e: Record<string, any>) => { e.key_id = 'foreign'; },
    (e: Record<string, any>) => { e.payload.draft_id = 'another'; },
    (e: Record<string, any>) => { e.payload.preview.bcc = []; },
  ]) {
    const req = request();
    const envelope = JSON.parse(req.message.slice(MAIL_APPROVAL_PREFIX.length));
    mutate(envelope);
    req.message = MAIL_APPROVAL_PREFIX + canonicalMailJson(envelope);
    assert.equal(new LocalMailApproval(configPath, () => now).register(req, 'request', 7, 'session'), null);
  }
});

test('serverName, requesting user/session и confirm schema закреплены', () => {
  for (const req of [request({}, { serverName: 'fake' }), request({}, { mode: 'url' }), request({}, { requestedSchema: {} })]) {
    assert.equal(new LocalMailApproval(configPath, () => now).register(req, 'request', 7, 'session'), null);
  }
  assert.equal(new LocalMailApproval(configPath, () => now).register(request(), 'request', 8, 'session'), null);
  assert.equal(new LocalMailApproval(configPath, () => now).register(request(), 'request', 7, null), null);
});

for (const [name, userId, ws, data, exists] of [
  ['foreign user', 8, socket, frame(), true],
  ['unauthenticated', null, socket, frame(), true],
  ['closed WS', 7, { readyState: 3 }, frame(), true],
  ['foreign session', 7, socket, frame({ sessionId: 'other' }), true],
  ['missing session', 7, socket, frame({ sessionId: undefined }), true],
  ['deleted session', 7, socket, frame(), false],
  ['foreign request', 7, socket, frame({ requestId: 'other' }), true],
  ['raw SDK accept', 7, socket, frame({ type: 'accept' }), true],
  ['wrong confirm', 7, socket, frame({ updatedInput: { confirm: 'true' } }), true],
  ['snapshot substitution', 7, socket, frame({ updatedInput: { confirm: true, draft_id: 'other' } }), true],
  ['generic content shape', 7, socket, frame({ updatedInput: { content: { confirm: true } } }), true],
  ['truthy allow', 7, socket, frame({ allow: 'true' }), true],
] as const) {
  test(`нет доказательства для ${name}`, () => {
    const service = new LocalMailApproval(configPath, () => now);
    const pending = service.register(request(), 'request', 7, 'session')!;
    service.bindAuthenticatedConnection(ws as never, userId)(data, exists);
    assert.deepEqual(pending.finish(approve), { action: 'cancel' });
  });
}

test('raw generic resolver/hook accept с поддельным token не вызывает signer', () => {
  const service = new LocalMailApproval(configPath, () => now);
  const pending = service.register(request(), 'request', 7, 'session')!;
  assert.deepEqual(pending.finish({ allow: true, updatedInput: { confirm: true, local_mail_decision: { signature: 'fake' } } }), { action: 'cancel' });
  service.bindAuthenticatedConnection(socket as never, 7)(frame(), true);
  assert.deepEqual(pending.finish(approve), { action: 'cancel' });
});

test('отказ, отмена и повторное решение не создают approve', () => {
  for (const decision of [{ allow: false }, null, { cancelled: true }]) {
    const service = new LocalMailApproval(configPath, () => now);
    const pending = service.register(request(), 'request', 7, 'session')!;
    const receive = service.bindAuthenticatedConnection(socket as never, 7);
    receive(frame({ allow: false }), true);
    assert.equal(receive(frame(), true), true);
    assert.notEqual(pending.finish(decision).action, 'accept');
  }
});

test('challenge истёк при ожидании, dispose и expiry токена закрыты', () => {
  let clock = now;
  const service = new LocalMailApproval(configPath, () => clock);
  const pending = service.register(request({ expires_at: now + 50 }), 'request', 7, 'session')!;
  clock += 51;
  service.bindAuthenticatedConnection(socket as never, 7)(frame(), true);
  assert.deepEqual(pending.finish(approve), { action: 'cancel' });
  clock = now;
  const next = service.register(request({ nonce: '1f33fcfe-f41c-4a57-b3dc-8f41b454e243', expires_at: now + 50 }), 'next', 7, 'session')!;
  service.bindAuthenticatedConnection(socket as never, 7)(frame({ requestId: 'next' }), true);
  const result = next.finish(approve);
  const token = JSON.parse(result.content!.local_mail_decision as string) as { payload: Record<string, unknown> };
  assert.equal(token.payload.expires_at, now + 50);
  const cancelled = service.register(request({ nonce: '2f33fcfe-f41c-4a57-b3dc-8f41b454e243' }), 'cancelled', 7, 'session')!;
  cancelled.dispose();
  assert.deepEqual(cancelled.finish(approve), { action: 'cancel' });
});

test('конфиг/PKCS8: неверные права и symlink отклоняются без приватных данных', () => {
  chmodSync(privatePath, 0o644);
  assert.throws(() => new LocalMailApproval(configPath), /^Error: Некорректная административная конфигурация локального подтверждения Mail$/);
  chmodSync(privatePath, 0o600);
  const linked = path.join(root, 'linked.json');
  symlinkSync(configPath, linked);
  assert.throws(() => new LocalMailApproval(linked));
  const bad = path.join(root, 'bad.json');
  writeFileSync(bad, '{bad: PRIVATE SENTINEL}');
  assert.throws(() => new LocalMailApproval(bad), error => !String(error).includes('SENTINEL'));
});

test('административный keygen создаёт 0600 PKCS8, ничего не включает и не перезаписывает', () => {
  const keyPath = path.join(root, 'generated.pem');
  const publicPath = path.join(root, 'generated.json');
  const args = ['scripts/mail-approval-keygen.mjs', '--private-key', keyPath, '--public-key', publicPath];
  const created = spawnSync(process.execPath, args, { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root, DATABASE_PATH: path.join(root, 'unused.db') } });
  assert.equal(created.status, 0);
  assert.ok(readFileSync(keyPath, 'utf8').startsWith('-----BEGIN PRIVATE KEY-----'));
  const keyBefore = readFileSync(keyPath);
  assert.equal(spawnSync(process.execPath, args, { encoding: 'utf8', env: { HOME: root } }).status, 1);
  assert.deepEqual(readFileSync(keyPath), keyBefore);
  assert.equal(created.stdout.includes('PRIVATE KEY'), false);
  const generatedConfig = path.join(root, 'generated-config.json');
  writeFileSync(generatedConfig, JSON.stringify({ ...config, private_key_path: keyPath }), { mode: 0o600 });
  assert.ok(new LocalMailApproval(generatedConfig)); // загрузчик проверяет 0600 и Ed25519
});
