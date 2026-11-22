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

const target = 'project-env';
const profile = { revision: 'a'.repeat(64), publicKey: 'test', label: 'Тест', operation: 'env-apply' as const,
  requiredFields: [], targets: [{ id: target, label: 'Проект' }] };
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
        view.result.current.protectedData.attach(fields, target);
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
  expect(stageProtectedData).toHaveBeenCalledWith(profile, 'session-a', fields, target);
  expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.send', protectedDataId: 'opaque-id', content: 'Проверь подключение' }));
  expect(JSON.stringify([sendMessage.mock.calls, addMessage.mock.calls])).not.toMatch(/local-test-marker|TOKEN|LOGIN|project-env/);
  expect(view.result.current.protectedData.draft).toBeNull();
});

test('на небезопасном HTTP просит HTTPS, не открывает форму и не отправляет данные', async () => {
  vi.stubGlobal('isSecureContext', false);
  const { view, sendMessage } = setup();
  await act(async () => view.result.current.protectedData.open());
  expect(view.result.current.protectedData.issue).toBe('notSecure');
  expect(view.result.current.protectedData.editor).toBeNull();
  expect(loadProtectedDataProfile).not.toHaveBeenCalled();
  expect(stageProtectedData).not.toHaveBeenCalled();
  expect(sendMessage).not.toHaveBeenCalled();
});

test('отмена редактирования сохраняет выбор, смена чата стирает его и при возврате', async () => {
  const { view, attach } = setup();
  await attach();
  await act(async () => view.result.current.protectedData.open());
  expect(view.result.current.protectedData.draft?.target).toBe(target);
  act(() => view.result.current.protectedData.close());
  expect(view.result.current.protectedData.draft?.target).toBe(target);
  view.rerender({ session: 'session-b', busy: false });
  view.rerender({ session: 'session-a', busy: false });
  expect(view.result.current.protectedData.draft).toBeNull();
});

test('открытие нового профиля и закрытие формы не переписывают уже приложенный набор', async () => {
  const { view, attach, submit } = setup();
  await attach();
  const draft = view.result.current.protectedData.draft;
  const next = { ...profile, revision: 'b'.repeat(64), targets: [...profile.targets, { id: 'chat-destination', label: 'По заданию в чате' }] };
  vi.mocked(loadProtectedDataProfile).mockResolvedValueOnce(next);
  await act(async () => view.result.current.protectedData.open());
  expect(view.result.current.protectedData.editor).toBe(next);
  act(() => view.result.current.protectedData.close());
  expect(view.result.current.protectedData.draft).toBe(draft);
  await act(submit);
  expect(stageProtectedData).toHaveBeenCalledExactlyOnceWith(profile, 'session-a', fields, target);
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
