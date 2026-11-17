import assert from 'node:assert/strict';
import test from 'node:test';

import { ResponseMetricsCollector } from '@/modules/websocket/services/response-metrics.service.js';
import { createCompleteMessage, createNormalizedMessage } from '@/shared/utils.js';

// GOLDJAXE fork (реестр §26): никаких сетевых запросов/CLI, только SDK-fixtures.
const terminal = () => createCompleteMessage({ provider: 'claude', exitCode: 0 });
const result = (uuid: string, tokens: unknown, extra = {}) => ({
  type: 'result', subtype: 'success', uuid, usage: { output_tokens: tokens },
  duration_api_ms: 999999, modelUsage: { main: { outputTokens: 99999 }, agent: { outputTokens: 88888 } },
  ...extra,
});
const finish = (collector: ResponseMetricsCollector) => collector.finish('run', 100, 5100, terminal());

test('§26: только reported main-loop usage, distinct per-turn results, без ложного TPS', () => {
  const collector = new ResponseMetricsCollector();
  collector.observeSdkMessage(result('first', 20));
  collector.observeSdkMessage(result('first', 20));
  collector.observeSdkMessage({ type: 'assistant', parent_tool_use_id: null, message: { model: 'main-model', usage: { output_tokens: 3000 } } }, 'high');
  collector.observeSdkMessage(result('subagent', 700, { parent_tool_use_id: 'agent-tool' }));
  collector.observeSdkMessage({ type: 'assistant', parent_tool_use_id: 'agent-tool', message: { model: 'other-model' } }, 'low');
  collector.observeSdkMessage(result('second', 30), 'high');
  assert.deepEqual(finish(collector), {
    runId: 'run', startedAt: 100, completedAt: 5100, durationMs: 5000,
    outcome: 'completed', outputTokens: 50, model: 'main-model', effort: 'high',
  });
});

test('§26: отсутствие, невалидный и промежуточный usage не становятся нулём/оценкой', () => {
  for (const tokens of [undefined, -1, NaN, Infinity, 1.5, '30']) {
    const collector = new ResponseMetricsCollector();
    collector.observeSdkMessage(result('r', tokens));
    assert.equal(finish(collector).outputTokens, undefined);
  }
  const collector = new ResponseMetricsCollector();
  collector.observeSdkMessage(result('r', 0));
  assert.equal(finish(collector).outputTokens, 0, 'точный reported ноль допустим');
  collector.observeSdkMessage({ type: 'stream_event', event: { type: 'message_start' } });
  assert.equal(finish(collector).outputTokens, undefined, 'незавершённый follow-up не полный usage рана');
});

test('§26: остановка/ошибка сохраняют длительность, незавершённый usage не показывается', () => {
  const collector = new ResponseMetricsCollector();
  collector.observeSdkMessage(result('r', 100));
  const stopped = collector.finish('run', 100, 2100, createCompleteMessage({ provider: 'claude', exitCode: 0, aborted: true }));
  assert.equal(stopped.outcome, 'stopped');
  assert.equal(stopped.durationMs, 2000);
  assert.equal(stopped.outputTokens, undefined);
  collector.observeMessage(createNormalizedMessage({ provider: 'claude', kind: 'error', content: 'runtime crashed' }));
  assert.equal(collector.finish('run', 100, 5100, createCompleteMessage({ provider: 'claude', exitCode: 1 })).outcome, 'failed');
  assert.equal(finish(collector).outputTokens, undefined);
  const sdkFailure = new ResponseMetricsCollector();
  sdkFailure.observeSdkMessage(result('failed-result', 10, { is_error: true }));
  assert.equal(finish(sdkFailure).outcome, 'failed', 'subtype success + is_error — ошибка SDK');
  assert.equal(finish(sdkFailure).outputTokens, 10);
});

test('§26: восстановимый error и неудачный result не портят исход успешного retry', () => {
  const collector = new ResponseMetricsCollector();
  collector.observeMessage(createNormalizedMessage({ provider: 'claude', kind: 'error', content: 'Повторяем запрос' }));
  collector.observeSdkMessage(result('retry-success', 10));
  assert.equal(finish(collector).outcome, 'completed');
  assert.equal(finish(collector).outputTokens, 10);
  collector.observeSdkMessage(result('retry-failed', 2, { is_error: true }));
  assert.equal(finish(collector).outcome, 'failed');
  collector.observeSdkMessage(result('final-success', 20));
  assert.equal(finish(collector).outcome, 'completed');
  assert.equal(collector.finish('run', 100, 5100, createCompleteMessage({ provider: 'claude', exitCode: 1 })).outcome, 'failed');
});

test('§26: цель только последняя anchored assistant-строка main loop', () => {
  const collector = new ResponseMetricsCollector();
  const prose = (id: string, uuid?: string, extra = {}) => {
    collector.observeSdkMessage({ type: 'assistant', uuid });
    return createNormalizedMessage({ id, kind: 'text', role: 'assistant', provider: 'claude', content: 'ответ', ...extra });
  };
  collector.observeMessage(prose('first_0', 'first'));
  collector.observeMessage(prose('final_0', 'final'));
  collector.observeMessage(prose('agent_0', 'agent', { parentToolUseId: 'tool' }));
  collector.observeMessage(prose('compact_0', undefined, { compact: { phase: 'done' } }));
  collector.observeMessage(prose('marker', undefined, { contextCleared: true }));
  assert.equal(collector.targetId, 'final_0');
  assert.equal(collector.anchorId, 'final');
  collector.observeMessage(prose('generated-without-uuid'));
  assert.equal(collector.targetId, undefined, 'нет fallback на предыдущую anchored строку');
});

const start = (id: string, outputTokens: unknown = 1) => ({
  type: 'message_start', message: { id, usage: { output_tokens: outputTokens } },
});
const delta = (outputTokens: unknown, stopReason: string | null = 'end_turn') => ({
  type: 'message_delta', usage: { output_tokens: outputTokens }, delta: { stop_reason: stopReason },
});
const stream = (event: unknown, parent: string | null = null) => ({ type: 'stream_event', event, parent_tool_use_id: parent });

test('§26: скорость по полным root spans, без tools, subagents и повторных message.id', () => {
  let now = 0;
  const collector = new ResponseMetricsCollector(() => now, () => 999);
  collector.observeSdkMessage(stream(start('api-1')));
  now = 1000;
  const live = collector.observeSdkMessage(stream(delta(51)));
  assert.deepEqual(live, { tokensPerSecond: 50, sampledAt: 999 });
  assert.equal(collector.observeSdkMessage(stream(delta(51))), undefined, 'тот же counter не свежий sample');
  now = 2000;
  collector.observeSdkMessage(stream({ type: 'message_stop' }));
  now = 90000; // Работа tools между API-вызовами не попадает в apiDurationMs.
  collector.observeSdkMessage(stream(start('agent'), 'agent-tool'));
  collector.observeSdkMessage(stream(delta(9999), 'agent-tool'));
  collector.observeSdkMessage(stream({ type: 'message_stop' }, 'agent-tool'));
  collector.observeSdkMessage(stream(start('api-1'))); // Повтор API не считается.
  collector.observeSdkMessage(stream(delta(9999)));
  collector.observeSdkMessage(stream({ type: 'message_stop' }));
  collector.observeSdkMessage(stream(start('api-2', 0)));
  now = 91000;
  collector.observeSdkMessage(stream(delta(150)));
  collector.observeSdkMessage(stream({ type: 'message_stop' }));
  collector.observeSdkMessage(result('r', 201));
  const metrics = finish(collector);
  assert.equal(metrics.outputTokens, 201, 'per-turn total отдельно, не сложен со stream counts');
  assert.equal(metrics.sampledOutputTokens, 200);
  assert.equal(metrics.apiDurationMs, 3000);
  assert.equal(metrics.tokensPerSecond, 200 / 3);
});

test('§26: fallback A→B не подписывает смешанную итоговую скорость последней моделью', () => {
  let now = 0;
  const collector = new ResponseMetricsCollector(() => now, () => 999);
  for (const model of ['model-a', 'model-b']) {
    collector.observeSdkMessage(stream({ type: 'message_start', message: { id: model, model, usage: { output_tokens: 0 } } }));
    now += 1000;
    assert.deepEqual(collector.observeSdkMessage(stream(delta(50))), { tokensPerSecond: 50, sampledAt: 999 });
    collector.observeSdkMessage(stream({ type: 'message_stop' }));
  }
  collector.observeSdkMessage(result('final', 100));
  const metrics = finish(collector);
  assert.equal(metrics.model, 'model-b');
  assert.equal(metrics.outputTokens, 100);
  assert.equal(metrics.apiDurationMs, undefined);
  assert.equal(metrics.sampledOutputTokens, undefined);
  assert.equal(metrics.tokensPerSecond, undefined);
});

test('§26: пропуски usage/stop, rollback счётчика и нулевой интервал не дают скорости', () => {
  const cases = [
    [{ type: 'message_start', message: { id: 'api', usage: {} } }, delta(10), { type: 'message_stop' }],
    [start('api', -1), delta(10), { type: 'message_stop' }],
    [start('api'), { type: 'message_stop' }],
    [start('api'), delta(10)],
    [start('api'), delta('10'), { type: 'message_stop' }],
    [start('api'), delta(10), delta(5), { type: 'message_stop' }],
    [start('api'), delta(10, null), { type: 'message_stop' }],
    [start('api'), delta(10), { type: 'message_delta' }, { type: 'message_stop' }],
  ];
  for (const events of cases) {
    let now = 0;
    const collector = new ResponseMetricsCollector(() => ++now);
    for (const event of events) collector.observeSdkMessage(stream(event));
    assert.equal(finish(collector).tokensPerSecond, undefined, JSON.stringify(events));
    assert.equal(finish(collector).apiDurationMs, undefined);
  }
  const collector = new ResponseMetricsCollector(() => 1);
  collector.observeSdkMessage(stream(start('api')));
  assert.equal(collector.observeSdkMessage(stream(delta(10))), undefined);
  collector.observeSdkMessage(stream({ type: 'message_stop' }));
  assert.equal(finish(collector).tokensPerSecond, undefined);
});
