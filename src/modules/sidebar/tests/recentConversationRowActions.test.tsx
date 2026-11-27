import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import React from 'react';
import { beforeEach, test, vi } from 'vitest';

import type { ActiveSidebarRename, RecentConversationListItem, SessionRowActions, SidebarProjectListProps } from '@/shared/types';

/**
 * The Conversations list renders the same controls as the Projects list, from
 * the same component. These tests assert what the row resolves for it — which
 * session, which project, and the two states that change the row's appearance —
 * by capturing the props of a stubbed SessionOptions, the way
 * sidebarRowProps.test.tsx captures the row props.
 */

const recordedOptionsProps: Record<string, unknown>[] = [];
const waitingIds = new Set<string>();

vi.mock('@/shared/context/WaitingConfirmationIdsContext', () => ({ useWaitingConfirmationIds: () => waitingIds }));
vi.mock('@/modules/sidebar/SessionOptions', () => ({
  default: (props: Record<string, unknown>) => {
    recordedOptionsProps.push(props);
    return null;
  },
}));

const { default: SidebarRecentConversations } = await import('@/modules/sidebar/SidebarRecentConversations');

const t = ((key: string) => key) as unknown as SidebarProjectListProps['t'];
const NOW = new Date('2026-08-21T10:00:00.000Z');
const noop = () => {};

const conversation = (
  sessionId: string,
  overrides: Partial<RecentConversationListItem> = {},
): RecentConversationListItem => ({
  sessionId,
  provider: 'claude',
  projectId: 'project-1',
  projectDisplayName: 'project one',
  sessionTitle: `title of ${sessionId}`,
  lastActivity: '2026-08-21T09:30:00.000Z',
  isPinned: false,
  fullTitle: null,
  ...overrides,
});

const makeActions = (overrides: Partial<SessionRowActions> = {}): SessionRowActions => ({
  activeRename: null,
  activeSessions: new Set<string>(),
  backgroundSessionIds: new Set<string>(),
  attentionSessionIds: new Set<string>(),
  onRenameDraftChange: noop,
  onStartEditingSession: noop,
  onCancelEditingSession: noop,
  onSaveEditingSession: noop,
  onArchiveSession: noop,
  onDeleteSession: noop,
  regeneratingTitleSessionIds: new Set<string>(),
  onRegenerateSessionTitle: noop,
  onToggleSessionPin: noop,
  ...overrides,
});

const renderList = (
  conversations: RecentConversationListItem[],
  sessionActions: SessionRowActions,
  currentSessionId?: string,
) => render(
  <SidebarRecentConversations
    conversations={conversations}
    total={conversations.length}
    hasMore={false}
    isLoading={false}
    isLoadingMore={false}
    hasError={false}
    currentSessionId={currentSessionId}
    currentTime={NOW}
    sessionActions={sessionActions}
    onConversationSelect={noop}
    onLoadMore={noop}
    onRetry={noop}
    t={t}
  />,
);

beforeEach(() => {
  recordedOptionsProps.length = 0;
  waitingIds.clear();
});

test('every conversation row gets the shared session controls', () => {
  renderList([conversation('s1'), conversation('s2')], makeActions());

  assert.equal(recordedOptionsProps.length, 2);
  assert.equal(recordedOptionsProps[0].sessionId, 's1');
  assert.equal(recordedOptionsProps[0].sessionName, 'title of s1');
  assert.equal(recordedOptionsProps[0].provider, 'claude');
  assert.equal(recordedOptionsProps[0].projectId, 'project-1');
});

test('only the open conversation is current, even before its project resolves', () => {
  const { container } = renderList([
    conversation('latest', { sessionTitle: 'same title' }),
    conversation('open', { sessionTitle: 'same title', projectId: null }),
  ], makeActions({ attentionSessionIds: new Set(['latest', 'open']) }), 'open');

  const currentLinks = container.querySelectorAll('a[aria-current="page"]');
  assert.equal(currentLinks.length, 1);
  assert.equal(currentLinks[0].getAttribute('href'), '/session/open');
  assert.ok(currentLinks[0].classList.contains('bg-accent'));
  assert.equal(container.querySelectorAll('.bg-amber-500').length, 1, 'only an unopened row shows unread activity');
});

test('the conversation list has no current row outside a session route', () => {
  const { container } = renderList([conversation('s1')], makeActions());
  assert.equal(container.querySelector('[aria-current]'), null);
});

test('a conversation with no known project still renders, and says so', () => {
  renderList([conversation('s1', { projectId: null })], makeActions());

  // SessionOptions withholds rename on a null projectId rather than guessing one.
  assert.equal(recordedOptionsProps.length, 1);
  assert.equal(recordedOptionsProps[0].projectId, null);
});

test('the rename open elsewhere does not put this row into editing', () => {
  const activeRename: ActiveSidebarRename = {
    target: 'session',
    id: 's2',
    projectId: 'project-1',
    draft: 'a new name',
  };
  renderList([conversation('s1'), conversation('s2')], makeActions({ activeRename }));

  assert.equal(recordedOptionsProps[0].isEditing, false);
  assert.equal(recordedOptionsProps[0].renameDraft, '');
  assert.equal(recordedOptionsProps[1].isEditing, true);
  assert.equal(recordedOptionsProps[1].renameDraft, 'a new name');
});

test('a project rename never puts a session row into editing', () => {
  const activeRename: ActiveSidebarRename = { target: 'project', id: 's1', draft: 'x' };
  renderList([conversation('s1')], makeActions({ activeRename }));

  assert.equal(recordedOptionsProps[0].isEditing, false);
});

test('a running session is marked processing and shows a spinner instead of its age', () => {
  const { container } = renderList(
    [conversation('s1'), conversation('s2')],
    makeActions({ activeSessions: new Set(['s1']) }),
  );

  assert.equal(recordedOptionsProps[0].isProcessing, true);
  assert.equal(recordedOptionsProps[1].isProcessing, false);
  assert.equal(container.querySelectorAll('.animate-spin').length, 1);
  assert.equal(container.querySelectorAll('time').length, 1);
});

test('a session with only background work running gets the purple dot, not the spinner, and is not processing', () => {
  // Its turn has ended: the row's destructive actions stay available and
  // nothing spins, but the session still counts as running and says so.
  const { container } = renderList(
    [conversation('s1'), conversation('s2')],
    makeActions({ activeSessions: new Set(['s1']), backgroundSessionIds: new Set(['s1']) }),
  );

  assert.equal(recordedOptionsProps[0].isProcessing, false);
  assert.equal(container.querySelectorAll('.animate-spin').length, 0);
  const dots = container.querySelectorAll('[role="status"].bg-purple-500');
  assert.equal(dots.length, 1);
  assert.equal(dots[0].getAttribute('aria-label'), 'tooltips.backgroundWorkIndicator');
  assert.equal(container.querySelectorAll('time').length, 1, 'the other row shows its age');
});

test('a session needing attention gets the amber dot', () => {
  const { container } = renderList(
    [conversation('s1'), conversation('s2')],
    makeActions({ attentionSessionIds: new Set(['s2']) }),
  );

  const dots = container.querySelectorAll('[role="status"].bg-amber-500');
  assert.equal(dots.length, 1);
  assert.equal(dots[0].classList.contains('animate-pulse'), false);
  assert.equal(dots[0].getAttribute('aria-label'), 'tooltips.newActivityIndicator');
  const rows = container.querySelectorAll('[data-testid="recent-conversation-row"]');
  assert.equal(rows.length, 2);
});

test('ожидание в «Разговорах» видно вместо спиннера, не меняя пин и действия строки', () => {
  waitingIds.add('s2');
  const { container } = renderList(
    [conversation('s1'), conversation('s2', { isPinned: true })],
    makeActions({ activeSessions: new Set(['s1', 's2']), attentionSessionIds: new Set(['s2']) }),
  );
  const first = container.querySelector('a[href="/session/s1"]');
  const second = container.querySelector('a[href="/session/s2"]');
  assert.ok(first?.querySelector('.animate-spin'));
  assert.equal(second?.querySelector('[role="status"]')?.textContent, 'tooltips.waitingForConfirmation');
  assert.ok(second?.querySelector('.lucide-pin'));
  assert.equal(container.querySelector('.bg-amber-500, svg[role="img"]'), null);
  assert.equal(second?.querySelector('.animate-spin'), null);
  assert.equal(recordedOptionsProps[1].isProcessing, true);
  assert.equal(recordedOptionsProps[1].provider, 'claude');
});
