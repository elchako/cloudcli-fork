import assert from 'node:assert/strict';

import React from 'react';
import { act, fireEvent, render, renderHook } from '@testing-library/react';
import i18n from 'i18next';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import ResponseMetricsControl from '@/modules/chat/transcript/ResponseMetricsControl';
import ActivityIndicator from '@/modules/chat/composer/ActivityIndicator';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import { resetUserPreferences, writeUserPreference } from '@/shared/userSettings';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import { formatGenerationSpeed, formatResponseDuration } from '@/modules/chat/utils/responseMetrics';
import type { NormalizedMessage, ProjectSession, ResponseMetrics, ServerEvent } from '@/shared/types';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';

const metrics: ResponseMetrics = {
  runId: 'run-1', startedAt: 1000, completedAt: 139000, durationMs: 138000,
  outcome: 'completed', outputTokens: 480, apiDurationMs: 10000, tokensPerSecond: 48,
};
const row = (id: string, extra: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  id, sessionId: 'session-1', provider: 'claude', kind: 'text', role: 'assistant',
  timestamp: '2026-11-17T12:00:00.000Z', content: id, ...extra,
});

beforeEach(async () => {
  resetUserPreferences();
  await i18n.changeLanguage('en');
});
afterEach(() => vi.useRealTimers());

test('форматы секунд, минут и часов однозначны; невалидные скорости скрыты', () => {
  assert.equal(formatResponseDuration(8000, 'ru'), '8 с');
  assert.equal(formatResponseDuration(138000, 'ru'), '2 мин 18 с');
  assert.equal(formatResponseDuration(4020000, 'ru'), '1 ч 07 мин');
  assert.equal(formatResponseDuration(4020000, 'en'), '1 h 07 m');
  assert.equal(formatResponseDuration(4023000, 'ru', true), '1 ч 07 мин 03 с');
  assert.equal(formatResponseDuration(250, 'ru', true), '250 мс');
  assert.equal(formatResponseDuration(NaN, 'ru'), '');
  assert.equal(formatGenerationSpeed(undefined, 'ru'), null);
  assert.equal(formatGenerationSpeed(Infinity, 'ru'), null);
  assert.equal(formatGenerationSpeed(0, 'ru'), null);
  assert.equal(formatGenerationSpeed(0.5, 'ru'), '0,5');
  assert.equal(formatGenerationSpeed(0.01, 'ru'), '<0,1');
});

test('по умолчанию видна только длительность; подробности доступны нажатием', () => {
  const { container } = render(<UiPreferencesProvider><ResponseMetricsControl metrics={metrics} /></UiPreferencesProvider>);
  const summary = container.querySelector('summary')!;
  assert.equal(summary.textContent, '2 m 18 s');
  assert.doesNotMatch(summary.textContent ?? '', /tok\/s/);
  fireEvent.click(summary);
  assert.ok(container.querySelector('details[open]'));
  assert.match(container.textContent ?? '', /480/);
});

test('свёрнутые показатели наследуют стиль футера, подробности сохраняют читаемость', () => {
  const { container } = render(<UiPreferencesProvider><ResponseMetricsControl metrics={metrics} /></UiPreferencesProvider>);
  const details = container.querySelector('details')!;
  const summary = container.querySelector('summary')!;
  assert.doesNotMatch(details.className, /text-/);
  assert.ok(summary.classList.contains('min-h-11'), 'область нажатия по-прежнему 44 px');
  assert.ok(summary.classList.contains('tabular-nums'));
  const panel = details.querySelector('div')!;
  assert.ok(panel.classList.contains('text-xs'));
  assert.ok(panel.classList.contains('text-foreground/75'));
});

test('переключатели независимы и меняются без перезагрузки', () => {
  const { container } = render(<UiPreferencesProvider><ResponseMetricsControl metrics={metrics} /></UiPreferencesProvider>);
  act(() => writeUserPreference('uiPreferences', { showResponseDuration: false, showGenerationSpeed: true }));
  assert.equal(container.querySelector('summary')?.textContent, '48 tok/s');
  act(() => writeUserPreference('uiPreferences', { showResponseDuration: false, showGenerationSpeed: false }));
  assert.equal(container.querySelector('summary'), null);
});

test('скорость без данных не заменяется нулём; остановка явно обозначена', () => {
  writeUserPreference('uiPreferences', { showGenerationSpeed: true });
  const { container } = render(<UiPreferencesProvider><ResponseMetricsControl metrics={{ ...metrics, outcome: 'stopped', tokensPerSecond: undefined }} /></UiPreferencesProvider>);
  assert.equal(container.querySelector('summary')?.textContent, 'Stopped · 2 m 18 s');
  assert.doesNotMatch(container.textContent ?? '', /0 tok\/s/);
});

test('complete обновляет только точный ответ, включая кешированную проекцию', () => {
  const early = row('early');
  const final = row('final');
  const initial = normalizedToChatMessages([early, final]);
  const complete = row('complete', { kind: 'complete', responseMetrics: metrics, responseMetricsTargetId: 'final' });
  const updated = normalizedToChatMessages([early, final, complete]);
  assert.strictEqual(updated[0], initial[0]);
  assert.notStrictEqual(updated[1], initial[1]);
  assert.equal(updated[0].responseMetrics, undefined);
  assert.deepEqual(updated[1].responseMetrics, metrics);
  const reloaded = normalizedToChatMessages([early, row('final', { responseMetrics: metrics })]);
  assert.deepEqual(reloaded[1].responseMetrics, metrics);
  const missingTarget = normalizedToChatMessages([early, row('complete', { kind: 'complete', responseMetrics: metrics })]);
  assert.equal(missingTarget[0].responseMetrics, undefined);
});

test('метрики подагента не попадают в основную ленту', () => {
  const projected = normalizedToChatMessages([
    row('parent'),
    row('child', { parentToolUseId: 'tool-1', responseMetrics: metrics }),
    row('done', { kind: 'complete', parentToolUseId: 'tool-1', responseMetrics: metrics, responseMetricsTargetId: 'child' }),
  ]);
  assert.equal(projected.length, 1);
  assert.equal(projected[0].responseMetrics, undefined);
});

test('терминальное WS-событие сохраняет метрики остановленного ответа до REST reload', () => {
  const { result } = renderHook(() => useSessionStore());
  const store = result.current;
  let listener: ((event: ServerEvent) => void) | undefined;
  const refresh = vi.fn(async () => {});
  const processing = vi.fn();
  const budget = vi.fn();
  const sample = { tokensPerSecond: 48, sampledAt: Date.now() };
  renderHook(() => useChatRealtimeHandlers({
    isActive: true,
    subscribe: (fn) => { listener = fn; return () => { listener = undefined; }; },
    provider: 'claude', selectedSession: { id: 'session-1' } as ProjectSession,
    currentSessionId: 'session-1', setTokenBudget: budget,
    onSessionProcessing: processing,
    getSessionActivity: () => ({ statusText: 'Generating', canInterrupt: true, startedAt: Date.now(), generationMetrics: sample }),
    pendingPermissionRequests: [], setPendingPermissionRequests: () => {},
    streamTimerRef: { current: null }, accumulatedStreamRef: { current: '' },
    lastSeqRef: { current: new Map() }, statusCheckSentAtRef: { current: new Map() },
    requestLatestMessages: refresh, sessionStore: store,
  }));
  const stopped = { ...metrics, outcome: 'stopped' as const };
  act(() => listener!(row('sample', { kind: 'status', text: 'generation_metrics', generationMetrics: sample }) as ServerEvent));
  assert.deepEqual(processing.mock.lastCall, ['session-1', { generationMetrics: sample }]);
  processing.mockClear();
  act(() => {
    listener!(row('final') as ServerEvent);
    listener!(row('old-tool', { kind: 'tool_result', toolId: 'old-tool', backgroundRelay: true }) as ServerEvent);
    listener!(row('old-status', { kind: 'status', text: 'Old background status', backgroundRelay: true }) as ServerEvent);
    listener!(row('old-budget', { kind: 'status', text: 'token_budget', tokenBudget: { used: 999 }, backgroundRelay: true }) as ServerEvent);
    listener!({ ...row('done', { kind: 'complete', responseMetrics: stopped, responseMetricsTargetId: 'final' }), aborted: true } as ServerEvent);
  });
  const projected = normalizedToChatMessages(store.getMessages('session-1'));
  assert.deepEqual(projected[0].responseMetrics, stopped);
  assert.equal(processing.mock.calls.length, 0, 'старый фон не сбрасывает замер/статус нового хода');
  assert.equal(budget.mock.calls.length, 0, 'контекст нового хода не подменяется старым');
  assert.equal(refresh.mock.calls.length, 0, 'метрики остановки видны без отложенного REST-запроса');
});

test('текущая скорость только свежая, по opt-in, и никогда для фоновой работы', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-17T12:00:00Z'));
  const activity = { statusText: 'Generating', canInterrupt: true, startedAt: Date.now() - 5000,
    generationMetrics: { tokensPerSecond: 48, sampledAt: Date.now() } };
  const { container, rerender } = render(<ActivityIndicator activity={activity} />);
  assert.doesNotMatch(container.textContent ?? '', /tok\/s/);
  rerender(<ActivityIndicator activity={activity} showGenerationSpeed showDuration={false} />);
  assert.match(container.textContent ?? '', /≈48 tok\/s/);
  act(() => vi.advanceTimersByTime(6000));
  assert.doesNotMatch(container.textContent ?? '', /tok\/s/);
  rerender(<ActivityIndicator activity={{ ...activity, background: true }} showGenerationSpeed />);
  assert.doesNotMatch(container.textContent ?? '', /tok\/s/);
});
