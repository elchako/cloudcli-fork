import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project, ProjectSession } from '@/shared/types';

/**
 * Regression guard for the live title update of the OPEN chat.
 *
 * An AI title used to reach only the sidebar's `projects` collection: the
 * header and the browser tab kept the raw prompt until a full refetch. The
 * `session_upserted` handler now merges the fresh summary/fullTitle into
 * `selectedSession` — without touching a different session's open chat, and
 * without blanking a known title when an event carries an empty summary.
 */

const projectsResponse = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    projects: () => projectsResponse(),
    projectTaskmaster: () => Promise.resolve({ ok: false }),
    sessionDetails: () => Promise.resolve({ ok: false }),
    projectSessions: () => Promise.resolve({ ok: false }),
  },
}));

const SESSION_ID = 'session-1';
const OTHER_SESSION_ID = 'session-2';

const buildProject = (sessions: ProjectSession[]): Project => ({
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
  sessions,
  sessionMeta: { hasMore: false, total: sessions.length },
});

const respondWith = (projects: Project[]) => {
  projectsResponse.mockResolvedValue({ ok: true, json: async () => projects });
};

type ServerEventListener = (event: Record<string, unknown>) => void;

const listeners = new Set<ServerEventListener>();

const emit = (event: Record<string, unknown>) => {
  for (const listener of listeners) {
    listener(event);
  }
};

const buildUpsert = (
  sessionId: string,
  summary: string,
  fullTitle: string | null,
) => ({
  kind: 'session_upserted',
  sessionId,
  providerSessionId: sessionId,
  provider: 'claude',
  session: {
    id: sessionId,
    summary,
    messageCount: 0,
    lastActivity: '2026-01-02T00:00:00.000Z',
    fullTitle,
  },
  project: {
    projectId: 'project-1',
    path: '/repo',
    fullPath: '/repo',
    displayName: 'Repo',
    isStarred: false,
  },
  timestamp: '2026-01-02T00:00:00.000Z',
});

const renderProjectsState = async () => {
  const { useProjectsState } = await import(
    '@/modules/project-workspace/hooks/useProjectsState'
  );

  return renderHook(() =>
    useProjectsState({
      sessionId: SESSION_ID,
      navigate: vi.fn() as never,
      subscribe: (listener: ServerEventListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      isMobile: false,
      isSessionProcessing: () => false,
    }),
  );
};

type HookResult = {
  current: {
    handleSessionSelect: (session: ProjectSession) => void;
    selectedSession: ProjectSession | null;
  };
};

const openSession = async (result: HookResult, session: ProjectSession) => {
  act(() => {
    result.current.handleSessionSelect(session);
  });
  await waitFor(() => {
    assert.equal(result.current.selectedSession?.id, session.id);
  });
};

beforeEach(() => {
  localStorage.clear();
  projectsResponse.mockReset();
  listeners.clear();
});

afterEach(() => {
  vi.resetModules();
});

test('a title upsert for the open session updates its header data live', async () => {
  const rawPrompt = 'Подготовь план тестирования переноса, очень длинный исходный запрос';
  respondWith([buildProject([
    { id: SESSION_ID, summary: rawPrompt } as ProjectSession,
  ])]);

  const { result } = await renderProjectsState();
  await openSession(result, { id: SESSION_ID, summary: rawPrompt } as ProjectSession);

  await act(async () => {
    emit(buildUpsert(SESSION_ID, 'План тестирования переноса', rawPrompt));
  });

  assert.equal(result.current.selectedSession?.summary, 'План тестирования переноса');
  assert.equal(result.current.selectedSession?.fullTitle, rawPrompt);
});

test('a title upsert for another session leaves the open chat untouched', async () => {
  respondWith([buildProject([
    { id: SESSION_ID, summary: 'open chat' } as ProjectSession,
    { id: OTHER_SESSION_ID, summary: 'other chat' } as ProjectSession,
  ])]);

  const { result } = await renderProjectsState();
  await openSession(result, { id: SESSION_ID, summary: 'open chat' } as ProjectSession);

  await act(async () => {
    emit(buildUpsert(OTHER_SESSION_ID, 'renamed elsewhere', 'prompt'));
  });

  assert.equal(result.current.selectedSession?.summary, 'open chat');
});

test('an empty-summary upsert never blanks the open chat title', async () => {
  respondWith([buildProject([
    { id: SESSION_ID, summary: 'known title' } as ProjectSession,
  ])]);

  const { result } = await renderProjectsState();
  await openSession(result, { id: SESSION_ID, summary: 'known title' } as ProjectSession);

  await act(async () => {
    emit(buildUpsert(SESSION_ID, '', null));
  });

  assert.equal(result.current.selectedSession?.summary, 'known title');
  // An explicit null fullTitle is the database truth after a hand rename —
  // the tooltip text must go with it.
  assert.equal(result.current.selectedSession?.fullTitle, undefined);
});
