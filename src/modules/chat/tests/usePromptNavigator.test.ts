import assert from 'node:assert/strict';

import { createRef } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { ServerPrompt } from '@/modules/chat/utils/promptNavigator';
import type { ChatMessage } from '@/shared/types';

const requestPrompts = vi.fn<(sessionId: string, options?: { signal?: AbortSignal }) => Promise<Response>>();
vi.mock('@/shared/api', () => ({
  api: { providers: { sessionPrompts: (sessionId: string, options?: { signal?: AbortSignal }) => requestPrompts(sessionId, options) } },
}));
vi.mock('@/modules/chat/hooks/useChatMessages', () => ({ normalizedToChatMessages: () => [] }));
const { usePromptNavigator } = await import('@/modules/chat/hooks/usePromptNavigator');

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, second)).toISOString();
const listed = (sessionId: string, count = 3): ServerPrompt[] => Array.from({ length: count }, (_, index) => ({
  key: `${sessionId}-${index}`, anchorId: `${sessionId}-${index}`, timestamp: at(index + 1),
  fromEnd: (count - index - 1) * 60 + 10, text: `Вопрос ${index + 1}`, attachmentCount: 0, isCommand: false,
}));
const tail = (sessionId: string): ChatMessage[] => [{
  type: 'user', content: 'Вопрос 3', timestamp: at(3), transcriptAnchorId: `${sessionId}-2`,
}];
const response = (prompts: ServerPrompt[], total = 243) => ({
  ok: true,
  json: async () => ({ data: { prompts, total } }),
}) as Response;

type Snapshot = {
  sessionId: string | null;
  isActive: boolean;
  isProcessing: boolean;
  total: number;
  chatMessages: ChatMessage[];
};

function renderNavigator(overrides: Partial<Snapshot> = {}) {
  const initial: Snapshot = {
    sessionId: 'a', isActive: true, isProcessing: true, total: 243, chatMessages: tail('a'), ...overrides,
  };
  let total = initial.total;
  // Здесь проверяется загрузка списка; операции перехода к строкам не вызываются.
  const store = { getSessionSlot: () => ({ total }) } as unknown as SessionStore;
  const scrollContainerRef = createRef<HTMLDivElement>();
  const revealRowAt = vi.fn();
  const setIsUserScrolledUp = vi.fn();
  const rendered = renderHook((props: Snapshot) => {
    total = props.total;
    return usePromptNavigator({
      ...props, visibleMessages: props.chatMessages, sessionStore: store,
      scrollContainerRef, revealRowAt, setIsUserScrolledUp,
    });
  }, { initialProps: initial });
  return { ...rendered, initial };
}

const advance = async (milliseconds: number) => {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
};

beforeEach(() => {
  vi.useFakeTimers();
  requestPrompts.mockReset();
  requestPrompts.mockResolvedValue(response(listed('a')));
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

test('открытие работающего чата загружает полный список при одном вопросе в хвосте', async () => {
  const { result } = renderNavigator();
  assert.equal(result.current.entries.length, 1);
  await advance(300);
  assert.equal(requestPrompts.mock.calls.length, 1);
  assert.equal(requestPrompts.mock.calls[0][0], 'a');
  assert.deepEqual(result.current.entries.map((entry) => entry.key), ['a-0', 'a-1', 'a-2']);
});

test('события потока до и после 300 мс не откладывают первый запрос и не запускают новые', async () => {
  const { initial, rerender, result } = renderNavigator();
  for (let index = 1; index <= 6; index += 1) {
    await advance(50);
    rerender({ ...initial, total: initial.total + index });
  }
  assert.equal(requestPrompts.mock.calls.length, 1);
  assert.equal(result.current.entries.length, 3);
  for (let index = 7; index <= 15; index += 1) {
    rerender({ ...initial, total: initial.total + index });
    await advance(100);
  }
  await advance(1000);
  assert.equal(requestPrompts.mock.calls.length, 1);
});

test('после окончания рана список обновляется, а изменения idle-истории схлопываются', async () => {
  const { initial, rerender, result } = renderNavigator();
  await advance(300);
  assert.equal(requestPrompts.mock.calls.length, 1);
  requestPrompts.mockResolvedValue(response(listed('a', 4), 260));
  rerender({ ...initial, isProcessing: false, total: 260 });
  await advance(100);
  rerender({ ...initial, isProcessing: false, total: 261 });
  await advance(100);
  rerender({ ...initial, isProcessing: false, total: 262 });
  await advance(299);
  assert.equal(requestPrompts.mock.calls.length, 1);
  await advance(1);
  assert.equal(requestPrompts.mock.calls.length, 2);
  assert.equal(result.current.entries.length, 4);
});

test('без сеанса и на неактивной вкладке запросов нет; активация работающего чата загружает список', async () => {
  const { initial, rerender } = renderNavigator({ sessionId: null });
  await advance(500);
  assert.equal(requestPrompts.mock.calls.length, 0);
  rerender({ ...initial, sessionId: 'a', isActive: false });
  await advance(500);
  assert.equal(requestPrompts.mock.calls.length, 0);
  rerender({ ...initial, sessionId: 'a', isActive: true });
  await advance(300);
  assert.equal(requestPrompts.mock.calls.length, 1);
});

test('уход со вкладки и размонтирование отменяют таймер или выполняющийся запрос', async () => {
  const { initial, rerender, unmount } = renderNavigator();
  await advance(100);
  rerender({ ...initial, isActive: false });
  await advance(500);
  assert.equal(requestPrompts.mock.calls.length, 0);
  requestPrompts.mockImplementation(() => new Promise(() => {}));
  rerender(initial);
  await advance(300);
  const signal = requestPrompts.mock.calls[0][1]?.signal;
  assert.equal(signal?.aborted, false);
  unmount();
  assert.equal(signal?.aborted, true);
});

test('поздний JSON-ответ предыдущего сеанса не заменяет список открытого чата', async () => {
  let resolvePrevious!: (value: unknown) => void;
  const previousJson = new Promise((resolve) => { resolvePrevious = resolve; });
  requestPrompts.mockResolvedValueOnce({ ok: true, json: () => previousJson } as Response);
  requestPrompts.mockResolvedValueOnce(response(listed('b')));
  const { initial, rerender, result } = renderNavigator({ isProcessing: false });
  await advance(300);
  const previousSignal = requestPrompts.mock.calls[0][1]?.signal;
  rerender({ ...initial, sessionId: 'b', chatMessages: tail('b') });
  assert.equal(previousSignal?.aborted, true);
  await advance(300);
  assert.deepEqual(result.current.entries.map((entry) => entry.key), ['b-0', 'b-1', 'b-2']);
  await act(async () => { resolvePrevious({ data: { prompts: listed('a'), total: 243 } }); });
  assert.deepEqual(result.current.entries.map((entry) => entry.key), ['b-0', 'b-1', 'b-2']);
});

test('ошибка запроса сохраняет загруженный хвост; окончание рана даёт новую попытку', async () => {
  requestPrompts.mockRejectedValueOnce(new Error('offline'));
  const { initial, rerender, result } = renderNavigator();
  await advance(300);
  assert.equal(requestPrompts.mock.calls.length, 1);
  assert.equal(result.current.entries.length, 1);
  rerender({ ...initial, isProcessing: false });
  await advance(300);
  assert.equal(requestPrompts.mock.calls.length, 2);
  assert.equal(result.current.entries.length, 3);
});

test('окончание рана обновляет список даже при неизменном total', async () => {
  const { initial, rerender } = renderNavigator();
  await advance(300);
  assert.equal(requestPrompts.mock.calls.length, 1);
  rerender({ ...initial, isProcessing: false });
  await advance(300);
  assert.equal(requestPrompts.mock.calls.length, 2);
});

test('поздний busy-ответ не заменяет свежий idle-список того же сеанса', async () => {
  let resolvePrevious!: (value: unknown) => void;
  const previousJson = new Promise((resolve) => { resolvePrevious = resolve; });
  requestPrompts.mockResolvedValueOnce({ ok: true, json: () => previousJson } as Response);
  requestPrompts.mockResolvedValueOnce(response(listed('a', 4)));
  const { initial, rerender, result } = renderNavigator();
  await advance(300);
  const previousSignal = requestPrompts.mock.calls[0][1]?.signal;
  rerender({ ...initial, isProcessing: false });
  assert.equal(previousSignal?.aborted, true);
  await advance(300);
  assert.equal(result.current.entries.length, 4);
  await act(async () => { resolvePrevious({ data: { prompts: listed('a'), total: 243 } }); });
  assert.equal(result.current.entries.length, 4);
});
