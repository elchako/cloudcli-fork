import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import type { TFunction } from 'i18next';
import type { ReactNode } from 'react';
import { beforeEach, test, vi } from 'vitest';

import WebSocketContext from '@/shared/context/WebSocketContext';
import type { Project, RecentConversationListItem, ServerEvent } from '@/shared/types';

const recentConversations = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    recentConversations: () => recentConversations(),
    archivedProjects: () => Promise.resolve({ ok: true, json: async () => ({ data: { projects: [] } }) }),
    getArchivedSessions: () => Promise.resolve({ ok: true, json: async () => ({ data: { sessions: [] } }) }),
  },
}));

const { useSidebarController } = await import('@/modules/sidebar/hooks/useSidebarController');
const t = ((key: string) => key) as TFunction;

beforeEach(() => {
  localStorage.clear();
  recentConversations.mockReset();
});

test('живые Разговоры сохраняют раскрытые проекты и снимают подписку при уходе со вкладки', async () => {
  const savedProjects = ['project-1', 'project-2'];
  localStorage.setItem('cloudcli-expanded-projects', JSON.stringify(savedProjects));
  let title = 'Исходное название';
  recentConversations.mockImplementation(async () => ({
    ok: true,
    json: async () => ({
      data: {
        conversations: [{
          sessionId: 'session-1', provider: 'claude', projectId: 'project-1',
          projectDisplayName: 'repo', sessionTitle: title, lastActivity: '2026-10-27T12:00:00Z',
          isPinned: true, fullTitle: 'Полный вопрос',
        } satisfies RecentConversationListItem],
        total: 1,
        hasMore: false,
      },
    }),
  }));
  const listeners = new Set<(event: ServerEvent) => void>();
  const socket = {
    ws: null,
    sendMessage: vi.fn(),
    subscribe: (listener: (event: ServerEvent) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    isConnected: true,
    connectionStatus: 'connected' as const,
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WebSocketContext.Provider value={socket}>{children}</WebSocketContext.Provider>
  );
  const projects: Project[] = [];
  const idleSessions = new Set<string>();
  const { result, unmount } = renderHook(() => useSidebarController({
    projects, selectedProject: null, selectedSession: null,
    activeSessions: idleSessions, backgroundSessionIds: idleSessions,
    isLoading: false, isMobile: true, t,
    onRefresh: vi.fn(), onProjectSelect: vi.fn(), onSessionSelect: vi.fn(),
    setCurrentProject: vi.fn(), setSidebarVisible: vi.fn(), sidebarVisible: true,
    keepProjectsExpanded: true,
  }), { wrapper });

  assert.equal(listeners.size, 0);
  assert.deepEqual(savedProjects.map((id) => result.current.isProjectExpanded(id)), [true, true]);
  act(() => { result.current.setSearchMode('conversations'); });
  await waitFor(() => { assert.equal(result.current.recentConversations.length, 1); });
  assert.equal(listeners.size, 1);

  title = 'Обновлённое название';
  act(() => {
    for (const listener of listeners) {
      listener({ kind: 'session_upserted', sessionId: 'session-1' });
      listener({ kind: 'websocket_reconnected' });
    }
  });
  await waitFor(() => { assert.equal(result.current.recentConversations[0]?.sessionTitle, title); });
  assert.equal(recentConversations.mock.calls.length, 2);
  assert.deepEqual(savedProjects.map((id) => result.current.isProjectExpanded(id)), [true, true]);
  assert.deepEqual(JSON.parse(localStorage.getItem('cloudcli-expanded-projects')!), savedProjects);
  assert.equal(result.current.recentConversations[0].isPinned, true);
  assert.equal(result.current.recentConversations[0].fullTitle, 'Полный вопрос');

  act(() => {
    for (const listener of listeners) listener({ kind: 'session_upserted' });
    result.current.setSearchMode('projects');
  });
  assert.equal(listeners.size, 0);
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 450); }); });
  assert.equal(recentConversations.mock.calls.length, 2);
  unmount();
});
