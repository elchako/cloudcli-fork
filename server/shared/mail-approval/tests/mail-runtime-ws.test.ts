import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, randomUUID, sign, verify } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';

import { WebSocket, WebSocketServer } from 'ws';
import type { ElicitationRequest, ElicitationResult } from '@anthropic-ai/claude-agent-sdk';

import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

// Конфигурация до импорта singleton; всё синтетическое, без чтения живого HOME.
const root = await mkdtemp(path.join(tmpdir(), 'mail-runtime-ws-'));
const issuer = generateKeyPairSync('ed25519');
const human = generateKeyPairSync('ed25519');
const keyPath = path.join(root, 'human.pem');
const configPath = path.join(root, 'config.json');
await writeFile(keyPath, human.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
await writeFile(configPath, JSON.stringify({
  private_key_path: keyPath, key_id: 'cloudcli-local-human',
  authorities: [{ tenant_id: 'tenant', user_id: 'user', client_id: 'client', cloudcli_user_id: '7',
    challenge_public_keys: { issuer: issuer.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url') } }],
}), { mode: 0o600 });
process.env.CLOUDCLI_MAIL_APPROVAL_CONFIG = configPath;
const { canonicalMailJson, mailSigningBytes, MAIL_APPROVAL_PREFIX } = await import('../index.js');
const { queryClaudeSDK, resolveToolApproval, getPendingApprovalsForSession } = await import('@/modules/providers/list/claude/claude-runtime.provider.js');
const { handleChatConnection } = await import('@/modules/websocket/services/chat-websocket.service.js');
const { initializeDatabase, closeConnection, getConnection, sessionsDb } = await import('@/modules/database/index.js');
const { connectedClients } = await import('@/modules/websocket/services/websocket-state.service.js');
const { CLAUDE_PREDEFINED_MODELS } = await import('@/modules/providers/list/claude/claude-models.provider.js');
const sessionId = 'mail-app-session';
await initializeDatabase();
getConnection().prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(7, 'mail-test', 'synthetic-not-a-credential');
sessionsDb.createAppSession(sessionId, 'claude', root);
test.after(async () => { closeConnection(); await rm(root, { recursive: true, force: true }); });

type OnElicitation = (r: ElicitationRequest, o: { signal: AbortSignal }) => Promise<ElicitationResult>;
function challengeRequest(): ElicitationRequest {
  const preview = { from: 'sender@example.test', to: ['to@example.test'], cc: [], bcc: ['blind@example.test'], subject: 'Synthetic', body: 'MAIL BODY SENTINEL', attachments: [] };
  const payload = { version: 1, audience: 'cloudcli-local-mail', tenant_id: 'tenant', user_id: 'user', client_id: 'client',
    draft_id: 'draft', revision: 1, preview, preview_hash: createHash('sha256').update(canonicalMailJson(preview)).digest('hex'),
    eml_sha256: 'e'.repeat(64), nonce: randomUUID(), issued_at: Date.now() - 100, expires_at: Date.now() + 60_000 };
  return { serverName: 'mail-local', mode: 'form',
    message: MAIL_APPROVAL_PREFIX + canonicalMailJson({ payload, key_id: 'issuer', signature: sign(null, mailSigningBytes('local-approval-challenge', payload), issuer.privateKey).toString('base64url') }),
    requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean', title: 'Отправить это письмо', default: false } }, required: ['confirm'] } };
}

async function withRun(runTest: (onElicitation: OnElicitation, frames: NormalizedMessage[]) => Promise<void>) {
  let capture!: (callback: OnElicitation) => void;
  const captured = new Promise<OnElicitation>(resolve => { capture = resolve; });
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const frames: NormalizedMessage[] = [];
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null, resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: () => [], isProviderInstalled: async () => true,
    createQuery: ({ options }) => {
      capture((options as { onElicitation: OnElicitation }).onElicitation);
      return Object.assign((async function* () { await finished; yield* [] as Record<string, unknown>[]; })(), { interrupt: async () => {}, stopTask: async () => {} });
    },
  };
  const run = queryClaudeSDK('synthetic', { sessionId, cwd: root }, { userId: 7, send: value => frames.push(value as NormalizedMessage) }, context);
  try { await runTest(await captured, frames); }
  finally { finish(); await run; }
}

async function withSocket(userId: number | null, runTest: (client: WebSocket) => Promise<void>) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  server.on('connection', (ws, req) => {
    // Моделируем результат JWT upgrade, а не данные входящего WS JSON.
    handleChatConnection(ws, Object.assign(req, { user: userId == null ? undefined : { id: userId } }), {
      runtime: { resolveToolApproval, getPendingApprovalsForSession } as never,
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await once(client, 'open');
  try { await runTest(client); }
  finally {
    client.close(); await once(client, 'close');
    await new Promise<void>(resolve => server.close(() => resolve()));
    connectedClients.clear();
  }
}

function pendingRequest(onElicitation: OnElicitation, frames: NormalizedMessage[]) {
  const controller = new AbortController();
  const result = onElicitation(challengeRequest(), { signal: controller.signal });
  const permission = frames.filter(frame => frame.kind === 'permission_request').at(-1)!;
  assert.ok(permission);
  assert.equal(JSON.stringify(permission).includes('signature'), false);
  assert.equal(JSON.stringify(permission).includes(MAIL_APPROVAL_PREFIX), false);
  const input = permission.input as Record<string, unknown>;
  assert.equal((input.localMailPreview as Record<string, unknown>).body, 'MAIL BODY SENTINEL');
  return { result, controller, requestId: permission.requestId };
}
const response = (requestId: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({
  type: 'chat.permission-response', requestId, sessionId, allow: true, updatedInput: { confirm: true }, ...extra,
});

test('настоящий WS round trip возвращает canonical JSON signed envelope из onElicitation целиком', async () => {
  await withRun(async (onElicitation, frames) => {
    const pending = pendingRequest(onElicitation, frames);
    await withSocket(7, async client => {
      client.send(response(pending.requestId));
      const result = await pending.result;
      assert.equal(result.action, 'accept');
      assert.equal(typeof result.content?.local_mail_decision, 'string');
      const token = JSON.parse(result.content!.local_mail_decision as string) as { payload: Record<string, unknown>; signature: string };
      assert.equal(token.payload.request_id, pending.requestId);
      assert.equal(token.payload.conversation_id, sessionId);
      assert.equal(token.payload.channel, 'cloudcli_native');
      assert.ok(verify(null, mailSigningBytes('local-human-decision', token.payload), human.publicKey, Buffer.from(token.signature, 'base64url')));
      // Flat MCP content: canonical строка не отбрасывается и не меняется при сериализации.
      assert.equal(JSON.parse(JSON.stringify(result)).content.local_mail_decision, canonicalMailJson(token));
      assert.equal(getPendingApprovalsForSession(sessionId).length, 0);
    });
  });
});

test('уже отменённый challenge не регистрируется и не показывается после отмены', async () => {
  await withRun(async (onElicitation, frames) => {
    const controller = new AbortController();
    controller.abort();
    assert.deepEqual(await onElicitation(challengeRequest(), { signal: controller.signal }), { action: 'cancel' });
    assert.equal(frames.some(frame => frame.kind === 'permission_request'), false);
    assert.equal(getPendingApprovalsForSession(sessionId).length, 0);
  });
});

test('generic resolver/hook accept не доказывает human origin и не переносит forged token', async () => {
  await withRun(async (onElicitation, frames) => {
    const pending = pendingRequest(onElicitation, frames);
    resolveToolApproval(String(pending.requestId), { allow: true, updatedInput: { confirm: true, content: { local_mail_decision: { signature: 'forged' } } } });
    assert.deepEqual(await pending.result, { action: 'cancel' });
  });
});

for (const [name, userId, framePatch] of [
  ['foreign user', 8, {}], ['unauthenticated', null, {}],
  ['foreign session', 7, { sessionId: 'foreign' }], ['foreign request', 7, { requestId: 'foreign' }],
  ['replaced snapshot', 7, { updatedInput: { confirm: true, preview: { body: 'evil' } } }],
] as const) {
  test(`WS ${name} не разрешает зарегистрированное Mail подтверждение`, async () => {
    await withRun(async (onElicitation, frames) => {
      const pending = pendingRequest(onElicitation, frames);
      await withSocket(userId, async client => {
        client.send(response(pending.requestId, { ...framePatch, userId: 7 }));
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(getPendingApprovalsForSession(sessionId).length, 1);
        pending.controller.abort();
        assert.deepEqual(await pending.result, { action: 'cancel' });
      });
    });
  });
}

test('WS отказ не подписывается; повторное approve того же request ничего не меняет', async () => {
  await withRun(async (onElicitation, frames) => {
    const pending = pendingRequest(onElicitation, frames);
    await withSocket(7, async client => {
      client.send(response(pending.requestId, { allow: false }));
      client.send(response(pending.requestId));
      assert.deepEqual(await pending.result, { action: 'decline' });
    });
  });
});

test('непочтовая elicitation остаётся обычной формой с прежним updatedInput.content', async () => {
  await withRun(async (onElicitation, frames) => {
    const result = onElicitation({ serverName: 'vault', message: 'ordinary', requestedSchema: { type: 'object', properties: { text: { type: 'string' } } } }, { signal: new AbortController().signal });
    const permission = frames.filter(frame => frame.kind === 'permission_request').at(-1)!;
    resolveToolApproval(String(permission.requestId), { allow: true, updatedInput: { content: { text: 'yes' } } });
    assert.deepEqual(await result, { action: 'accept', content: { text: 'yes' } });
  });
});
