import { webcrypto } from 'node:crypto';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { loadProtectedDataProfile, stageProtectedData } from '@/modules/chat/protected-data/protected-data-client';
import { resetChatDrafts } from '@/shared/chatDrafts';

vi.mock('@/modules/chat/protected-data/protected-data-client', () => ({
  loadProtectedDataProfile: vi.fn(),
  stageProtectedData: vi.fn(),
}));

const profile = { revision: 'a'.repeat(64), publicKey: 'test', label: 'Тест', requiredFields: ['TOKEN'] };
const fields = [{ name: 'TOKEN', value: 'only-local-test-marker' }, { name: 'LOGIN', value: 'other-local-test-marker' }];
const project = { projectId: 'project', displayName: 'Project', fullPath: '/tmp/project' };
const sessions = { 'session-a': { id: 'session-a' }, 'session-b': { id: 'session-b' } };

function setup() {
  const sendMessage = vi.fn();
  const addMessage = vi.fn();
  const view = renderHook(({ session, busy }: { session: keyof typeof sessions; busy: boolean }) => useChatComposerState({
    selectedProject: project,
    selectedSession: sessions[session],
    currentSessionId: session,
    provider: 'claude',
    permissionMode: 'default',
    cyclePermissionMode: () => {},
    resolvePermissionModeForProvider: () => 'default',
    currentProviderModel: 'model',
    currentProviderEffort: 'medium',
    isLoading: busy,
    canAbortSession: true,
    tokenBudget: null,
    sendMessage,
    addMessage,
    scrollToBottom: () => {},
    setIsUserScrolledUp: () => {},
    setPendingPermissionRequests: () => {},
  }), { initialProps: { session: 'session-a', busy: false } });
  return {
    view, sendMessage, addMessage,
    attach: async () => {
      await act(async () => view.result.current.protectedData.open());
      act(() => {
        view.result.current.protectedData.attach(fields);
        view.result.current.setInput('Проверь подключение');
      });
    },
    submit: () => view.result.current.handleSubmit({ preventDefault: () => {} } as never),
  };
}

beforeEach(() => {
  resetChatDrafts();
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')));
  vi.mocked(loadProtectedDataProfile).mockResolvedValue(profile);
  vi.mocked(stageProtectedData).mockResolvedValue('opaque-id');
});

afterEach(() => {
  resetChatDrafts();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

test('обычный ход получает только ID набора; локальное эхо не получает значения', async () => {
  const { view, sendMessage, addMessage, attach, submit } = setup();
  await attach();
  await act(submit);
  expect(stageProtectedData).toHaveBeenCalledWith(profile, 'session-a', fields);
  expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.send', protectedDataId: 'opaque-id', content: 'Проверь подключение' }));
  expect(JSON.stringify([sendMessage.mock.calls, addMessage.mock.calls])).not.toMatch(/local-test-marker|TOKEN|LOGIN/);
  expect(view.result.current.protectedData.draft).toBeNull();
});

test('ошибка подготовки не отправляет текст отдельно и оставляет плашку для исправления', async () => {
  const { view, sendMessage, attach, submit } = setup();
  vi.mocked(stageProtectedData).mockRejectedValueOnce(new Error('private error details'));
  await attach();
  await act(submit);
  expect(sendMessage).not.toHaveBeenCalled();
  expect(view.result.current.protectedData.issue).toBe('stageFailed');
  expect(view.result.current.protectedData.draft?.fields).toEqual(fields);
});

test('смена чата при подготовке не запускает старый ход и не переносит значения', async () => {
  const { view, sendMessage, attach, submit } = setup();
  let resolve!: (id: string) => void;
  vi.mocked(stageProtectedData).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  await attach();
  let submitting!: Promise<void>;
  act(() => { submitting = submit(); });
  view.rerender({ session: 'session-b', busy: false });
  await act(async () => { resolve('id-in-a'); await submitting; });
  expect(sendMessage).not.toHaveBeenCalled();
  expect(view.result.current.protectedData.draft).toBeNull();
});

test('защищённый набор не уходит в очередь или steering', async () => {
  const { view, sendMessage, attach, submit } = setup();
  await attach();
  view.rerender({ session: 'session-a', busy: true });
  await act(submit);
  await act(() => view.result.current.handleSendMenuChoice('steer'));
  expect(stageProtectedData).not.toHaveBeenCalled();
  expect(sendMessage).not.toHaveBeenCalled();
  expect(view.result.current.protectedData.draft?.fields).toEqual(fields);
});
