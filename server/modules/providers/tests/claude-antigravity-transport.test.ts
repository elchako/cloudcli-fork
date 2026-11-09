import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import { query } from '@anthropic-ai/claude-agent-sdk';

import {
  CLOUDCLI_AGENT_IDENTITY, SDK_AGENT_IDENTITY, createAntigravityTransport,
  isAntigravityModel, neutralizeAntigravityIdentity,
} from '@/modules/providers/list/claude/claude-antigravity-transport.js';
import { queryClaudeSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import type { AnyRecord, ProviderModelsDefinition, ProviderRuntimeContext } from '@/shared/types.js';

const catalog: ProviderModelsDefinition = { DEFAULT: 'gemini-3.8-flash-high', OPTIONS: [
  { value: 'gemini-3.8-flash-high', label: 'Flash', catalogProvider: 'antigravity' },
  { value: 'claude-sonnet-5-5-high', label: 'Sonnet', catalogProvider: 'antigravity' },
  { value: 'gpt-6.1-sol', label: 'GPT', catalogProvider: 'openai' },
  { value: 'claude-opus-5-5', label: 'Native Claude', catalogProvider: 'anthropic' },
] };
const payload = () => ({ model: 'gemini-3.8-flash-high(high)', max_tokens: 128000, stream: true,
  output_config: { effort: 'high' }, thinking: { type: 'adaptive' },
  system: [{ type: 'text', text: 'x-anthropic-billing-header: fixture' },
    { type: 'text', text: SDK_AGENT_IDENTITY, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'Keep safety policy, project rules and tool permissions unchanged.' }],
  tools: [{ name: 'Read', input_schema: { type: 'object', properties: {} } }],
  messages: [{ role: 'user', content: SDK_AGENT_IDENTITY }],
});

test('провайдер берётся из каталога, suffix и restore-модель распознаются без переименования', () => {
  assert.equal(isAntigravityModel('gemini-3.8-flash-high(high)', catalog), true);
  assert.equal(isAntigravityModel('claude-sonnet-5-5-high(low)', catalog), true);
  assert.equal(isAntigravityModel('gpt-6.1-sol(high)', catalog), false);
  assert.equal(isAntigravityModel('gemini-unknown', catalog), false);
});

test('меняется только точный system identity, все поля запроса и cache-control сохраняются', () => {
  const original = payload();
  const copy = structuredClone(original);
  const actual = neutralizeAntigravityIdentity(original, catalog);
  copy.system[1].text = CLOUDCLI_AGENT_IDENTITY;
  assert.deepEqual(actual, copy);
  assert.equal(original.system[1].text, SDK_AGENT_IDENTITY);
  assert.equal(original.messages[0].content, SDK_AGENT_IDENTITY);
});

test('нативные Claude/GPT, произвольный текст и неизвестные модели проходят без изменений', () => {
  for (const model of ['claude-opus-5-5', 'gpt-6.1-sol(high)', 'gemini-unknown']) {
    const body = { ...payload(), model };
    assert.equal(neutralizeAntigravityIdentity(body, catalog), body);
  }
  const body = { ...payload(), system: [{ type: 'text', text: `Quote: ${SDK_AGENT_IDENTITY}` }] };
  assert.equal(neutralizeAntigravityIdentity(body, catalog), body);
});

test('legacy system string исправляется, в том числе в восстановленном запросе', () => {
  const body = { ...payload(), system: SDK_AGENT_IDENTITY };
  assert.deepEqual(neutralizeAntigravityIdentity(body, catalog), { ...body, system: CLOUDCLI_AGENT_IDENTITY });
});

test('настоящий HTTP сохраняет beta, авторизацию, SSE, исходный model и high; повторов нет', async (t) => {
  const received: Array<{ url: string; headers: Record<string, unknown>; body: unknown }> = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    received.push({ url: req.url!, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Cpa-Trace-Id': 'fixture-trace' });
    res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
    res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const address = upstream.address(); assert.ok(address && typeof address !== 'string');
  const adapter = await createAntigravityTransport(`http://127.0.0.1:${address.port}/provider`, catalog);
  t.after(() => adapter.close());
  const body = payload();
  const response = await fetch(`${adapter.baseUrl}/v1/messages?beta=true`, { method: 'POST', headers: {
    'Authorization': 'Bearer fixture-only', 'Content-Type': 'application/json',
    'Anthropic-Version': '2023-06-01', 'Anthropic-Beta': 'fixture-beta',
  }, body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-cpa-trace-id'), 'fixture-trace');
  assert.ok((await response.text()).includes('message_stop'));
  assert.equal(received.length, 1);
  assert.equal(received[0].url, '/provider/v1/messages?beta=true');
  assert.equal(received[0].headers.authorization, 'Bearer fixture-only');
  assert.equal(received[0].headers['anthropic-beta'], 'fixture-beta');
  const expected = payload(); expected.system[1].text = CLOUDCLI_AGENT_IDENTITY;
  assert.deepEqual(received[0].body, expected);
  const denied = await fetch(adapter.baseUrl.replace(/\/[^/]+$/, '') + '/v1/messages');
  assert.equal(denied.status, 404);
  assert.equal(received.length, 1);
});

test('429 и Retry-After отдаются без локальных повторов и скрытия upstream ошибки', async (t) => {
  let count = 0;
  const upstream = createServer(async (req, res) => {
    for await (const _chunk of req) { /* дочитать запрос */ }
    count++;
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '120' });
    res.end('{"error":{"message":"Individual quota reached"}}');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const address = upstream.address(); assert.ok(address && typeof address !== 'string');
  const adapter = await createAntigravityTransport(`http://127.0.0.1:${address.port}`, catalog);
  t.after(() => adapter.close());
  const response = await fetch(`${adapter.baseUrl}/v1/messages?beta=true`, { method: 'POST', body: JSON.stringify(payload()) });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '120');
  const result = await response.json() as { error: { message: string } };
  assert.equal(result.error.message, 'Individual quota reached');
  assert.equal(count, 1);
});

test('сжатый SSE не получает неверные Content-Encoding/Length после fetch', async (t) => {
  const stream = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  const compressed = gzipSync(stream);
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Content-Encoding': 'gzip', 'Content-Length': compressed.length });
    res.end(compressed);
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const address = upstream.address(); assert.ok(address && typeof address !== 'string');
  const adapter = await createAntigravityTransport(`http://127.0.0.1:${address.port}`, catalog);
  t.after(() => adapter.close());
  const response = await fetch(`${adapter.baseUrl}/v1/models`);
  assert.equal(response.headers.get('content-encoding'), null);
  assert.equal(await response.text(), stream);
});

for (const scenario of [
  { model: 'gemini-3.8-flash-high', owner: 'antigravity', resume: null },
  { model: 'gemini-3.8-flash-high', owner: 'antigravity', resume: 'existing-native-id' },
  { model: 'gpt-6.1-sol', owner: 'openai', resume: 'existing-native-id' },
  { model: 'claude-opus-5-5', owner: 'anthropic', resume: null },
  { model: 'gemini-3.8-flash-high', owner: 'antigravity', resume: null, fail: true },
]) {
  test(`runtime ${scenario.model}, resume=${scenario.resume}, fail=${Boolean(scenario.fail)}: ID/effort/preset/permissions не меняются`, async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'antigravity-runtime-'));
    const previousBase = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9';
    let captured: AnyRecord | undefined;
    const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
    const context: ProviderRuntimeContext = {
      resolveProviderSessionId: () => scenario.resume,
      resolveResumeModel: async () => scenario.model,
      getProviderModels: async () => ({ DEFAULT: scenario.model, OPTIONS: [{ value: scenario.model,
        label: scenario.model, catalogProvider: scenario.owner,
        effort: { values: [{ value: 'high' }], ...(scenario.owner === 'antigravity' ? { transport: 'model-suffix' as const } : {}) },
      }] }),
      normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
      isProviderInstalled: async () => true,
      createQuery: ({ prompt, options }) => {
        captured = options;
        if (scenario.fail) throw new Error('Fixture SDK startup failure');
        void (async () => { for await (const _message of prompt) { /* stdin */ } })();
        return Object.assign((async function* () {
          yield { type: 'result', subtype: 'success', session_id: scenario.resume || 'new-native', result: 'ok', duration_ms: 1, num_turns: 1 };
        })(), { interrupt: async () => {} }) as never;
      },
    };
    try {
      await queryClaudeSDK('test', { sessionId: 'app-fixture', cwd, model: scenario.model, effort: 'high',
        toolsSettings: { allowedTools: ['Read'], disallowedTools: ['Bash'], skipPermissions: false },
      }, { send() {}, userId: null } as never, context);
      assert.ok(captured);
      assert.equal(captured.model, scenario.owner === 'anthropic' ? scenario.model : `${scenario.model}(high)`);
      assert.equal(captured.effort, 'high');
      assert.equal(captured.resume, scenario.resume || undefined);
      assert.deepEqual(captured.systemPrompt, { type: 'preset', preset: 'claude_code' });
      assert.deepEqual(captured.disallowedTools, ['Bash']);
      assert.equal(typeof captured.canUseTool, 'function');
      assert.deepEqual(captured.settingSources, ['project', 'user', 'local']);
      if (scenario.owner === 'antigravity') {
        assert.notEqual(captured.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9');
        assert.equal(captured.settings?.env?.ANTHROPIC_BASE_URL, captured.env.ANTHROPIC_BASE_URL,
          'flag-settings сохраняет адрес адаптера после загрузки user/project settings');
        await assert.rejects(fetch(`${captured.env.ANTHROPIC_BASE_URL}/v1/models`), 'адаптер закрыт в finally');
      } else {
        assert.equal(captured.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9');
        assert.equal(captured.settings?.env?.ANTHROPIC_BASE_URL, undefined);
      }
    } finally {
      if (previousBase === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = previousBase;
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

// GOLDJAXE fork (реестр §22.3): mock createQuery не замечает перезапись env внутри CLI.
// Явно заданный CLI нужен только этому полностью локальному интеграционному тесту.
test('настоящий CLI сохраняет адаптер при env в user/project/local settings', {
  skip: !process.env.CLOUDCLI_TEST_NATIVE_CLI_PATH, timeout: 45000,
}, async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'antigravity-native-settings-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const configDir = path.join(cwd, 'config');
  await mkdir(configDir);
  await mkdir(path.join(cwd, '.claude'));
  const received: Array<{ url: string; marker: unknown; body: AnyRecord }> = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    if (!req.url?.includes('/messages')) { res.end('{"data":[]}'); return; }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    received.push({ url: req.url, marker: req.headers['x-cloudcli-settings-fixture'], body });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = (type: string, data: AnyRecord) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event('message_start', { message: { id: 'msg_fixture', type: 'message', role: 'assistant',
      content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ОК' } });
    event('content_block_stop', { index: 0 });
    event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
    event('message_stop', {}); res.end();
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const address = upstream.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  for (const file of [path.join(configDir, 'settings.json'), path.join(cwd, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.local.json')]) {
    await writeFile(file, JSON.stringify({ env: { ANTHROPIC_BASE_URL: `${base}/settings-bypass`,
      ANTHROPIC_CUSTOM_HEADERS: 'X-CloudCLI-Settings-Fixture: loaded' } }));
  }
  const previousBase = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = base;
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  try {
    await queryClaudeSDK('Ответь ОК без инструментов.', { sessionId: 'native-settings-fixture', cwd,
      model: 'gemini-4-argon-high', effort: 'high',
      toolsSettings: { allowedTools: [], disallowedTools: ['Bash', 'Read'], skipPermissions: false },
    }, { send() {}, userId: null } as never, {
      resolveProviderSessionId: () => null, resolveResumeModel: async () => 'gemini-4-argon-high',
      getProviderModels: async () => ({ DEFAULT: 'gemini-4-argon-high', OPTIONS: [{ value: 'gemini-4-argon-high',
        label: 'Argon', catalogProvider: 'antigravity', effort: { transport: 'model-suffix', values: [{ value: 'high' }] } }] }),
      normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
      isProviderInstalled: async () => true,
      createQuery: ({ prompt, options }) => query({ prompt: prompt as Parameters<typeof query>[0]['prompt'], options: { ...options,
        pathToClaudeCodeExecutable: process.env.CLOUDCLI_TEST_NATIVE_CLI_PATH,
        tools: [], mcpServers: {}, maxTurns: 1,
        env: { ...options.env, HOME: cwd, CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: 'fixture-only',
          ANTHROPIC_AUTH_TOKEN: undefined, DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      } }),
    });
    assert.ok(received.length > 0, 'настоящий CLI отправил HTTP-запрос');
    for (const request of received) {
      assert.equal(request.url, '/v1/messages?beta=true', 'user/project/local env не обошёл адаптер');
      assert.equal(request.marker, 'loaded', 'остальные файловые настройки CLI продолжают загружаться');
      assert.equal(request.body.model, 'gemini-4-argon-high(high)');
      assert.ok(request.body.system.some((block: AnyRecord) => block.text === CLOUDCLI_AGENT_IDENTITY));
      assert.ok(!request.body.system.some((block: AnyRecord) => block.text === SDK_AGENT_IDENTITY));
    }
  } finally {
    if (previousBase === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = previousBase;
  }
});

test('отмена входящего SDK stream отменяет единственный upstream запрос', async (t) => {
  let count = 0;
  let upstreamClosed!: () => void;
  const closed = new Promise<void>(resolve => { upstreamClosed = resolve; });
  const upstream = createServer(async (req, res) => {
    for await (const _chunk of req) { /* дочитать тело */ }
    count++;
    res.once('close', upstreamClosed);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const address = upstream.address(); assert.ok(address && typeof address !== 'string');
  const adapter = await createAntigravityTransport(`http://127.0.0.1:${address.port}`, catalog);
  t.after(() => adapter.close());
  const controller = new AbortController();
  const response = await fetch(`${adapter.baseUrl}/v1/messages`, { method: 'POST', body: JSON.stringify(payload()), signal: controller.signal });
  const reader = response.body!.getReader();
  await reader.read(); controller.abort();
  await assert.rejects(reader.read());
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([closed, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Upstream was not cancelled')), 1500); })]);
  } finally { clearTimeout(timeout); }
  assert.equal(count, 1);
});

test('редирект не переносит ключ на другой endpoint, close освобождает listener', async (t) => {
  let redirected = 0;
  const upstream = createServer((req, res) => {
    if (req.url === '/steal') { redirected++; res.end('unexpected'); return; }
    res.writeHead(302, { Location: '/steal' }); res.end();
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const address = upstream.address(); assert.ok(address && typeof address !== 'string');
  const adapter = await createAntigravityTransport(`http://127.0.0.1:${address.port}`, catalog);
  const response = await fetch(`${adapter.baseUrl}/v1/models`, { headers: { Authorization: 'Bearer fixture' } });
  assert.equal(response.status, 502);
  assert.equal(redirected, 0);
  await adapter.close();
  await assert.rejects(fetch(`${adapter.baseUrl}/v1/models`));
});
