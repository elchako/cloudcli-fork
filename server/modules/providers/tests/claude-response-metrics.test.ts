import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, responseMetricsDb, sessionsDb } from '@/modules/database/index.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { queryClaudeSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { sessionHistoryCache } from '@/modules/providers/services/session-history-cache.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { AnyRecord, NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

// GOLDJAXE fork (реестр §26): только временная DB, искусственные transcripts и SDK.
const APP = 'metrics-app';
const NATIVE = 'metrics-transcript';
const PROJECT = '/tmp/metrics-project';
const provider = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });

async function isolated(check: (directory: string) => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'response-metrics-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  try {
    await check(directory);
  } finally {
    chatRunRegistry.clearAll();
    for (const id of [APP, `${APP}\u0000${NATIVE}`, 'fork-app']) sessionHistoryCache.invalidate(id);
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

const assistant = (uuid: string, text = 'Ответ', extra = {}): AnyRecord => ({
  type: 'assistant', uuid, session_id: NATIVE, sessionId: NATIVE,
  timestamp: '2026-01-01T00:00:02.000Z', parentUuid: 'prompt',
  message: { role: 'assistant', model: 'main-model', content: [{ type: 'text', text }] }, ...extra,
});
const sdkResult = (uuid = 'sdk-result', extra = {}) => ({
  type: 'result', subtype: 'success', uuid, session_id: NATIVE,
  usage: { output_tokens: 51 }, duration_api_ms: 9999999, duration_ms: 77777,
  modelUsage: { main: { outputTokens: 99999 }, agent: { outputTokens: 88888 } }, ...extra,
});

async function index(directory: string, rows: AnyRecord[], native = NATIVE, app = APP): Promise<string> {
  if (!sessionsDb.getSessionById(app)) sessionsDb.createAppSession(app, 'claude', PROJECT);
  sessionsDb.assignProviderSessionId(app, native);
  const file = path.join(directory, `${native}.jsonl`);
  await writeFile(file, rows.map((row) => JSON.stringify({ ...row, sessionId: native })).join('\n') + '\n');
  sessionsDb.createSession(native, 'claude', PROJECT, 'Метрики', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:05.000Z', file);
  return file;
}

function start(app = APP, native: string | null = NATIVE) {
  const frames: NormalizedMessage[] = [];
  const run = chatRunRegistry.startRun({
    appSessionId: app, provider: 'claude', providerSessionId: native,
    connection: { readyState: 1, send: (data) => { frames.push(JSON.parse(data)); } }, userId: null,
  });
  assert.ok(run);
  const publish = (raw: AnyRecord) => {
    run.writer.observeResponseMetrics(raw, 'high');
    for (const message of provider.normalizeMessage(raw, native)) {
      if (raw.parent_tool_use_id) message.parentToolUseId = raw.parent_tool_use_id;
      run.writer.send(message);
    }
  };
  return { run, frames, publish };
}

const metricsCount = () => (getConnection().prepare('SELECT count(*) AS n FROM response_metrics').get() as { n: number }).n;

test('§26: complete ровно один раз, последняя text-строка, durable reload и stat-кэш', async () => {
  await isolated(async (directory) => {
    const first = assistant('first');
    const final = assistant('final', '', { message: { role: 'assistant', model: 'main-model', content: [
      { type: 'text', text: 'Часть 1' }, { type: 'thinking', thinking: 'мысль' }, { type: 'text', text: 'Финал' },
    ] } });
    const file = await index(directory, [first, final]);
    const original = await readFile(file, 'utf8');
    assert.ok((await sessionsService.fetchHistory(APP)).messages.every((row) => !row.responseMetrics));
    const { run, frames, publish } = start();
    run.startedAt = Date.now() - 5000;
    publish(first);
    publish(final);
    publish(assistant('agent', 'Подагент', { parent_tool_use_id: 'tool' }));
    publish(sdkResult());
    run.writer.sendComplete({ exitCode: 0 });
    run.writer.sendComplete({ exitCode: 1 });
    const completes = frames.filter((row) => row.kind === 'complete');
    assert.equal(completes.length, 1);
    const complete = completes[0];
    assert.equal(complete.responseMetricsTargetId, 'final_2');
    assert.equal(complete.responseMetrics?.outcome, 'completed');
    assert.equal(complete.responseMetrics?.outputTokens, 51);
    assert.ok(complete.responseMetrics!.durationMs >= 5000);
    assert.ok(complete.responseMetrics!.durationMs < 77000, 'duration SDK не wall time registry');
    assert.equal(complete.responseMetrics?.tokensPerSecond, undefined);
    assert.equal(metricsCount(), 1);
    const cached = await sessionsService.fetchHistory(APP);
    assert.deepEqual(cached.messages.filter((row) => row.responseMetrics).map((row) => row.id), ['final_2']);
    responseMetricsDb.save({ sessionId: APP, providerSessionId: NATIVE, targetId: 'first_0', anchorId: 'first',
      metrics: { ...complete.responseMetrics!, durationMs: 1 } });
    chatRunRegistry.clearAll();
    closeConnection();
    await initializeDatabase();
    const reloaded = await sessionsService.fetchHistory(APP, { limit: 1 });
    assert.equal(reloaded.messages[0].id, 'final_2');
    assert.deepEqual(reloaded.messages[0].responseMetrics, complete.responseMetrics, 'повторная запись не меняет итог');
    assert.equal(await readFile(file, 'utf8'), original, 'CLI JSONL не изменён');
    sessionsDb.deleteSessionById(APP);
    assert.equal(metricsCount(), 0, 'FK удаляет метрики вместе с сессией');
  });
});

test('§26: остановка/ошибка и новый run не наследуют старую цель или runtime', async () => {
  await isolated(async (directory) => {
    await index(directory, [assistant('old')]);
    const old = start();
    old.publish(assistant('old'));
    old.run.writer.sendComplete({ exitCode: 0, aborted: true });
    assert.equal(old.frames.at(-1)?.responseMetrics?.outcome, 'stopped');
    const next = start();
    old.run.writer.setSessionId('foreign-transcript');
    old.publish(assistant('late'));
    old.publish(sdkResult('late-result'));
    chatRunRegistry.completeRunIfCurrent(old.run, { exitCode: 1 });
    assert.equal(chatRunRegistry.isProcessing(APP), true);
    assert.equal(sessionsDb.getSessionById(APP)?.provider_session_id, NATIVE);
    next.run.writer.sendComplete({ exitCode: 1 });
    assert.equal(next.frames.at(-1)?.responseMetrics?.outcome, 'failed');
    assert.equal(next.frames.at(-1)?.responseMetricsTargetId, undefined);
    assert.notEqual(next.frames.at(-1)?.responseMetrics?.runId, old.frames.at(-1)?.responseMetrics?.runId);
    assert.equal(metricsCount(), 2);
    assert.equal(old.frames.filter((row) => row.kind === 'complete').length, 1);
    assert.equal(old.frames.some((row) => row.id === 'late_0'), false);
  });
});

test('§26: фон старого хода доставляется через текущий writer, не меняя метрики нового', async () => {
  await isolated(async (directory) => {
    await index(directory, [assistant('old')]);
    const old = start();
    old.publish(assistant('old'));
    old.publish(sdkResult('old-result'));
    old.run.writer.sendComplete({ exitCode: 0 });
    const saved = old.frames.at(-1)!.responseMetrics;
    const current = start();
    current.publish(assistant('current'));
    current.publish(sdkResult('current-result'));
    old.run.writer.send({ id: 'background-task', kind: 'task_status', provider: 'claude', sessionId: NATIVE, taskId: 'task', event: 'notification', status: 'completed' });
    old.run.writer.send({ id: 'background-result', kind: 'tool_result', provider: 'claude', sessionId: NATIVE, toolId: 'tool', content: 'Готово' });
    old.publish(assistant('background-answer'));
    old.publish(sdkResult('background-sdk-error', { is_error: true }));
    old.run.writer.sendComplete({ exitCode: 1 });
    assert.equal(chatRunRegistry.isProcessing(APP), true);
    assert.deepEqual(current.frames.map((row) => row.id), ['current_0', 'background-task', 'background-result', 'background-answer_0']);
    assert.deepEqual(current.frames.map((row) => row.seq), [1, 2, 3, 4]);
    assert.deepEqual(current.frames.map((row) => Boolean(row.backgroundRelay)), [false, true, true, true]);
    assert.deepEqual(chatRunRegistry.replayEvents(APP, 1).map((row) => row.id), ['background-task', 'background-result', 'background-answer_0']);
    current.run.writer.sendComplete({ exitCode: 0 });
    const complete = current.frames.at(-1)!;
    assert.equal(complete.responseMetricsTargetId, 'current_0');
    assert.equal(complete.responseMetrics?.outcome, 'completed');
    assert.equal(complete.responseMetrics?.outputTokens, 51);
    assert.equal(current.frames.filter((row) => row.kind === 'complete').length, 1);
    assert.deepEqual(responseMetricsDb.listForTranscript(APP, NATIVE).find((row) => row.metrics.runId === old.run.runId)?.metrics, saved);
    assert.equal(metricsCount(), 2);
  });
});

test('§26: clear-context и fork с одинаковыми UUID не переносят метрики на другой ответ', async () => {
  await isolated(async (directory) => {
    const answer = assistant('same-uuid');
    await index(directory, [answer]);
    const first = start();
    first.publish(answer);
    first.run.writer.sendComplete({ exitCode: 0 });
    await sessionsService.clearSessionContext(APP);
    await index(directory, [assistant('same-uuid', 'Новый контекст')], 'new-transcript');
    const stitched = await sessionsService.fetchHistory(APP);
    assert.equal(stitched.messages[0].responseMetrics?.runId, first.run.runId);
    assert.equal(stitched.messages[0].transcriptAnchorId, undefined);
    assert.equal(stitched.messages.at(-1)?.content, 'Новый контекст');
    assert.equal(stitched.messages.at(-1)?.responseMetrics, undefined);
    await index(directory, [answer], 'fork-transcript', 'fork-app');
    assert.ok((await sessionsService.fetchHistory('fork-app')).messages.every((row) => !row.responseMetrics));
  });
});

test('§26: edit скрывает старую ветку, метрики не переезжают на замену', async () => {
  await isolated(async (directory) => {
    const root = assistant('root', 'Корень', { parentUuid: null, timestamp: '2026-01-01T00:00:00.000Z' });
    const prompt = (uuid: string) => ({ type: 'user', uuid, parentUuid: 'root', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: 'Запрос' } });
    const old = assistant('abandoned', 'Старый ответ', { parentUuid: 'old-prompt' });
    const rows = [root, prompt('old-prompt'), old];
    const file = await index(directory, rows);
    const previous = start();
    previous.publish(old);
    previous.run.writer.sendComplete({ exitCode: 0 });
    rows.push(prompt('new-prompt'), assistant('replacement', 'Новый ответ', { parentUuid: 'new-prompt' }));
    await writeFile(file, rows.map((row) => JSON.stringify({ ...row, sessionId: NATIVE })).join('\n'));
    sessionHistoryCache.invalidate(APP);
    const history = await sessionsService.fetchHistory(APP);
    assert.ok(!history.messages.some((row) => row.id === 'abandoned_0'));
    assert.ok(history.messages.some((row) => row.id === 'replacement_0'));
    assert.ok(history.messages.every((row) => !row.responseMetrics));
  });
});

test('§26: реальный цикл SDK запрашивает partial, отдаёт sample и не дублирует текст', async () => {
  await isolated(async (directory) => {
    await index(directory, []);
    const active = start();
    const before = Date.now();
    const context: ProviderRuntimeContext = {
      resolveProviderSessionId: () => NATIVE,
      resolveResumeModel: async () => undefined,
      getProviderModels: async () => CLAUDE_PREDEFINED_MODELS,
      normalizeMessage: (raw, sid) => provider.normalizeMessage(raw, sid),
      isProviderInstalled: async () => true,
      createQuery: ({ options }) => {
        assert.equal(options.includePartialMessages, true);
        const events = (async function* () {
          yield { type: 'system', subtype: 'init', session_id: NATIVE };
          yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'api', model: 'main-model', usage: { output_tokens: 1 } } } };
          yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Ответ' } } };
          yield assistant('runtime-answer');
          yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_delta', usage: { output_tokens: 51 }, delta: { stop_reason: 'end_turn' } } };
          yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } };
          yield sdkResult('runtime-result', { is_error: true });
        })();
        return Object.assign(events, { interrupt: async () => {} });
      },
    };
    await queryClaudeSDK('Запрос', { sessionId: APP, cwd: directory }, active.run.writer, context);
    assert.equal(active.frames.filter((row) => row.kind === 'text').length, 1);
    assert.equal(active.frames.filter((row) => row.kind === 'stream_delta').length, 0);
    const samples = active.frames.filter((row) => row.text === 'generation_metrics');
    assert.equal(samples.length, 1);
    assert.ok(samples[0].generationMetrics!.tokensPerSecond > 0);
    assert.ok(samples[0].generationMetrics!.sampledAt >= before && samples[0].generationMetrics!.sampledAt <= Date.now());
    const complete = active.frames.find((row) => row.kind === 'complete')!;
    assert.equal(complete.responseMetricsTargetId, 'runtime-answer_0');
    assert.equal(complete.responseMetrics?.outcome, 'failed', 'SDK success + is_error не считается успехом');
    assert.equal(complete.responseMetrics?.outputTokens, 51);
    assert.equal(complete.responseMetrics?.sampledOutputTokens, 50);
    assert.ok(complete.responseMetrics!.apiDurationMs! > 0);
    assert.equal(complete.responseMetrics?.tokensPerSecond, 50000 / complete.responseMetrics!.apiDurationMs!);
  });
});
