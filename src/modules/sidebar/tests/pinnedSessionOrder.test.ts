import assert from 'node:assert/strict';

import { test } from 'vitest';

import { getAllSessions } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import type { Project } from '@/shared/types';

/**
 * Fork (docs/ru/fork-changes.md §9.1): a pinned session stays at the top of its
 * project's list. The server returns it first, but the sidebar re-sorts each
 * project's sessions by date — which used to drop the pin back among the rest,
 * leaving only its icon.
 */

const project = (sessions: Array<{ id: string; lastActivity: string; isPinned?: boolean }>): Project => ({
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'repo',
  sessions: sessions.map((session) => ({ ...session, summary: session.id, __provider: 'claude' as const })),
}) as unknown as Project;

test('a pinned session sorts above newer unpinned ones', () => {
  const sessions = getAllSessions(project([
    { id: 'newest', lastActivity: '2026-10-09T12:00:00.000Z' },
    { id: 'pinned-old', lastActivity: '2026-10-01T12:00:00.000Z', isPinned: true },
    { id: 'middle', lastActivity: '2026-10-05T12:00:00.000Z' },
  ]));

  assert.deepEqual(sessions.map((session) => session.id), ['pinned-old', 'newest', 'middle']);
});

test('pinned sessions keep the usual newest-first order among themselves', () => {
  const sessions = getAllSessions(project([
    { id: 'pinned-old', lastActivity: '2026-10-01T12:00:00.000Z', isPinned: true },
    { id: 'plain', lastActivity: '2026-10-09T12:00:00.000Z' },
    { id: 'pinned-new', lastActivity: '2026-10-08T12:00:00.000Z', isPinned: true },
  ]));

  assert.deepEqual(sessions.map((session) => session.id), ['pinned-new', 'pinned-old', 'plain']);
});
