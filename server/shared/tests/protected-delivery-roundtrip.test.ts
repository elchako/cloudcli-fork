import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import type { AnyRecord, ProviderRuntimeContext } from '@/shared/types.js';

// Через настоящие gateway/runtime/MCP; только SDK-поток, сокеты и исполнитель — в памяти.
const home = await mkdtemp(join(tmpdir(), 'delivery-roundtrip-'));
process.env.HOME = home;
process.env.DATABASE_PATH = join(home, 'test.db');
process.env.CLOUDCLI_PROTECTED_DATA_MODE = 'memory';
const { protectedDataRelay } = await import('@/modules/protected-data/index.js');
const { CLAUDE_PREDEFINED_MODELS } = await import('@/modules/providers/list/claude/claude-models.provider.js');
const { queryClaudeSDK, getPendingApprovalsForSession, resolveToolApproval } = await import('@/modules/providers/list/claude/claude-runtime.provider.js');
const { closeConnection, initializeDatabase, getConnection, sessionsDb } = await import('@/modules/database/index.js');
const { handleChatConnection } = await import('@/modules/websocket/services/chat-websocket.service.js');
const { chatRunRegistry } = await import('@/modules/websocket/services/chat-run-registry.service.js');
await initializeDatabase();
getConnection().prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(7, 'test-owner', 'synthetic');
test.after(async () => { closeConnection(); await rm(home, { recursive: true, force: true }); });

class Socket extends EventEmitter {
  readyState = 1;
  frames: AnyRecord[] = [];
  send(json: string) { const frame = JSON.parse(json); this.frames.push(frame); this.emit(frame.kind, frame); }
  post(frame: object) { this.emit('message', JSON.stringify(frame)); }
  close() { this.readyState = 3; this.emit('close'); }
}

for (const outcome of ['allow', 'deny', 'close', 'turn-end', 'abort'] as const) {
  test(`WS → инструмент → карточка → ${outcome}`, { timeout: 10_000 }, async t => {
    const sessionId = randomUUID();
    sessionsDb.createAppSession(sessionId, 'claude', home);
    const profile = await protectedDataRelay.getProfile();
    assert.ok(profile);
    const id = await protectedDataRelay.stage('7', { version: 1, revision: profile.revision, sessionId, nonce: randomUUID(), issuedAt: Date.now(),
      names: ['TEST_KEY', 'UNSELECTED'], target: 'chat-destination', iv: '', wrappedKey: '', ciphertext: 'synthetic-not-opened' });
    assert.ok(id);
    const execute = t.mock.method(protectedDataRelay, 'execute', async () => 'delivered');
    const client = new Client({ name: 'test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    let ready!: () => void;
    const readyForTool = new Promise<void>(resolve => { ready = resolve; });
    const context: ProviderRuntimeContext = {
      resolveProviderSessionId: () => null, resolveResumeModel: async () => undefined,
      normalizeMessage: () => [], getProviderModels: async () => CLAUDE_PREDEFINED_MODELS, isProviderInstalled: async () => true,
      createQuery: ({ options }) => Object.assign((async function* () {
        // canUseTool намеренно не вызывается, как в SDK auto/bypass.
        assert.equal(options.permissionMode, 'bypassPermissions');
        await options.mcpServers['cloudcli-protected-data'].instance.connect(b);
        await client.connect(a);
        ready(); await finished;
        yield { type: 'result', subtype: 'success', result: '' };
      })(), { interrupt: async () => { finish(); } }),
    };
    let run: Promise<void> | undefined;
    const sockets = [7, 8, 7].map(userId => {
      const socket = new Socket();
      handleChatConnection(socket as never, { user: { id: userId } } as never, { runtime: {
        hasRuntime: () => true, hasBackgroundWork: () => false, getPendingApprovalsForSession, resolveToolApproval,
        abort: async () => { finish(); return true; },
        run: (_provider, command, options, writer) => (run = queryClaudeSDK(command, options, writer, context)),
        stopBackgroundTask: async () => false, steer: async () => false,
        askSideQuestion: async () => { throw new Error('Не используется'); },
      } });
      return socket;
    });
    const [owner, foreign, otherTab] = sockets;
    t.after(async () => { sockets.forEach(ws => ws.close()); finish(); await run; await client.close(); await b.close(); chatRunRegistry.clearAll(); });
    owner.post({ type: 'chat.send', sessionId, content: 'test', protectedDataId: id, options: { permissionMode: 'bypassPermissions' } });
    await readyForTool;
    const shown = once(owner, 'permission_request');
    const destination = 'https://example.invalid/test';
    const call = () => client.callTool({ name: 'deliver_protected_fields', arguments: { destination, fields: ['TEST_KEY'] } });
    const result = call();
    const [frame] = await shown;
    assert.equal(frame.sessionId, sessionId);
    assert.deepEqual(frame.input, { destinationPreview: `HTTPS POST · JSON с выбранными полями → ${destination}`, names: ['TEST_KEY'] });
    assert.deepEqual(getPendingApprovalsForSession(sessionId), []);
    for (const ws of sockets) {
      ws.post({ type: 'chat.subscribe', sessions: [{ sessionId, lastSeq: 0 }] });
      const ack = ws.frames.find(f => f.kind === 'chat_subscribed');
      assert.equal(ack?.pendingPermissions.length, ws === owner ? 1 : 0);
      if (ws !== owner) assert.ok(!JSON.stringify(ws.frames).includes(frame.requestId));
    }
    const decision = { type: 'chat.protected-delivery-decision', sessionId, requestId: frame.requestId, allow: true };
    resolveToolApproval(frame.requestId, { allow: true });
    owner.post({ ...decision, type: 'chat.permission-response' });
    foreign.post(decision); otherTab.post(decision);
    for (const patch of [{ updatedInput: {} }, { rememberEntry: 'always' }, { requestId: randomUUID() }, { sessionId: 'absent' }, { allow: 'true' }]) owner.post({ ...decision, ...patch });
    assert.equal(owner.frames.filter(f => f.kind === 'permission_resolved').length, 0);
    assert.equal(execute.mock.callCount(), 0);
    if (outcome === 'close') owner.close();
    else if (outcome === 'turn-end') finish();
    else if (outcome === 'abort') owner.post({ type: 'chat.abort', sessionId });
    else owner.post({ ...decision, allow: outcome === 'allow' });
    assert.equal(Boolean((await result).isError), outcome !== 'allow');
    owner.post(decision);
    assert.ok((await call()).isError);
    assert.equal(execute.mock.callCount(), Number(outcome === 'allow'));
  });
}
