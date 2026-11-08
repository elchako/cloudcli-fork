import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import type { TFunction } from 'i18next';
import { test, vi } from 'vitest';

import SidebarSessionItem from '@/modules/sidebar/SidebarSessionItem';
import type { LLMProvider, Project, SessionWithProvider } from '@/shared/types';

vi.mock('@/modules/sidebar/hooks/useCompactSidebar', () => ({
  useCompactSidebar: () => true,
}));

// Exercise the real shared capability hook: the mobile menu must follow the
// server matrix and withhold actions for missing or unsupported providers.
vi.mock('@/shared/api', () => ({
  api: {
    providerSessionId: async () => ({
      ok: true,
      json: async () => ({ data: { sessionId: 'native-session-1' } }),
    }),
    providers: {
      capabilities: async () => ({
        json: async () => ({
          success: true,
          data: {
            providers: [
              { provider: 'claude', supportsSessionForking: true },
              { provider: 'codex', supportsSessionForking: true },
              { provider: 'cursor', supportsSessionForking: false },
            ],
          },
        }),
      }),
    },
  },
}));

const PROJECT: Project = {
  projectId: 'project-1',
  displayName: 'Project one',
  fullPath: '/tmp/project-1',
};
const SESSION: SessionWithProvider = {
  id: 'session-1',
  summary: 'Session one',
  __provider: 'claude',
  __projectId: PROJECT.projectId,
};
const t = ((key: string) => key) as TFunction;
const noop = () => {};

const rowProps = (
  overrides: Partial<ComponentProps<typeof SidebarSessionItem>> = {},
): ComponentProps<typeof SidebarSessionItem> => ({
  project: PROJECT,
  session: SESSION,
  selectedSession: null,
  isProcessing: false,
  hasBackgroundWork: false,
  needsAttention: false,
  currentTime: new Date('2026-10-17T00:00:00.000Z'),
  isEditing: false,
  renameDraft: '',
  isRegeneratingTitle: false,
  onRegenerateSessionTitle: noop,
  onToggleSessionPin: noop,
  onRenameDraftChange: noop,
  onStartEditingSession: noop,
  onCancelEditingSession: noop,
  onSaveEditingSession: noop,
  onProjectSelect: noop,
  onSessionSelect: noop,
  onArchiveSession: noop,
  onDeleteSession: noop,
  onForkSession: noop,
  isSelecting: false,
  isChecked: false,
  onToggleSessionSelected: noop,
  t,
  ...overrides,
});

const openOptions = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Session options for Session one' }));
  });
  return within(screen.getByRole('dialog'));
};

test.each<LLMProvider>(['claude', 'codex'])('mobile offers a fork for a supported %s session', async (provider) => {
  render(<SidebarSessionItem {...rowProps({ session: { ...SESSION, __provider: provider } })} />);
  const sheet = await openOptions();

  assert.ok(sheet.getByRole('button', { name: /Fork session/ }));
  assert.ok(sheet.getByRole('button', { name: 'Rename session' }));
  assert.ok(sheet.getByRole('button', { name: 'Archive session' }));
  assert.ok(sheet.getByRole('button', { name: 'Delete session' }));
});

test.each([false, true])('мобильные пин и перегенерация работают рядом с fork (isPinned=%s)', async (isPinned) => {
  const onToggleSessionPin = vi.fn();
  const onRegenerateSessionTitle = vi.fn();
  render(<SidebarSessionItem {...rowProps({ session: { ...SESSION, isPinned }, onToggleSessionPin, onRegenerateSessionTitle })} />);
  let sheet = await openOptions();

  assert.ok(sheet.getByRole('button', { name: /Fork session/ }));
  fireEvent.click(sheet.getByRole('button', { name: isPinned ? 'tooltips.unpinSession' : 'tooltips.pinSession' }));
  assert.deepEqual(onToggleSessionPin.mock.calls, [[SESSION.id]]);
  assert.equal(screen.queryByRole('dialog'), null);

  sheet = await openOptions();
  fireEvent.click(sheet.getByRole('button', { name: 'tooltips.regenerateSessionTitle' }));
  assert.deepEqual(onRegenerateSessionTitle.mock.calls, [[SESSION.id]]);
  assert.equal(screen.queryByRole('dialog'), null);
});

test('мобильная строка сохраняет полный запрос, пин и выделение активного сеанса', () => {
  const fullTitle = 'Полный исходный запрос про исправление входа';
  render(<SidebarSessionItem {...rowProps({ session: { ...SESSION, fullTitle, isPinned: true }, selectedSession: SESSION })} />);
  const title = screen.getByText('Session one');

  assert.equal(title.getAttribute('title'), `Session one\n\n${fullTitle}`);
  assert.ok(title.classList.contains('font-semibold'));
  assert.ok(title.closest('[aria-current="true"]')?.classList.contains('bg-primary/15'));
  assert.ok(screen.getByLabelText('tooltips.pinnedSession'));
});

test('мобильная перегенерация не запускается повторно, пока название обновляется', async () => {
  const onRegenerateSessionTitle = vi.fn();
  render(<SidebarSessionItem {...rowProps({ isRegeneratingTitle: true, onRegenerateSessionTitle })} />);
  const sheet = await openOptions();
  const regenerate = sheet.getByRole('button', { name: 'tooltips.regenerateSessionTitle' });

  assert.ok(regenerate.hasAttribute('disabled'));
  fireEvent.click(regenerate);
  assert.equal(onRegenerateSessionTitle.mock.calls.length, 0);
});

test('mobile archive and delete are separate actions with their own handlers', async () => {
  const onArchiveSession = vi.fn();
  const onDeleteSession = vi.fn();
  const { unmount } = render(<SidebarSessionItem {...rowProps({ onArchiveSession, onDeleteSession })} />);
  let sheet = await openOptions();

  fireEvent.click(sheet.getByRole('button', { name: 'Archive session' }));
  assert.deepEqual(onArchiveSession.mock.calls, [[SESSION.id]]);
  assert.equal(onDeleteSession.mock.calls.length, 0);
  assert.equal(screen.queryByRole('dialog'), null);
  unmount();

  render(<SidebarSessionItem {...rowProps({ onArchiveSession, onDeleteSession })} />);
  sheet = await openOptions();
  fireEvent.click(sheet.getByRole('button', { name: 'Delete session' }));
  assert.deepEqual(onDeleteSession.mock.calls, [[SESSION.id, 'Session one']]);
  assert.equal(onArchiveSession.mock.calls.length, 1);
});

test('mobile withholds archive and delete while the session is running', async () => {
  render(<SidebarSessionItem {...rowProps({ isProcessing: true })} />);
  const sheet = await openOptions();

  assert.equal(sheet.queryByRole('button', { name: 'Archive session' }), null);
  assert.equal(sheet.queryByRole('button', { name: 'Delete session' }), null);
});

test('forking from the mobile sheet passes the owning session once and dismisses the sheet', async () => {
  const onForkSession = vi.fn();
  const onProjectSelect = vi.fn();
  const onSessionSelect = vi.fn();
  render(<SidebarSessionItem {...rowProps({ onForkSession, onProjectSelect, onSessionSelect })} />);
  const sheet = await openOptions();

  fireEvent.click(sheet.getByRole('button', { name: /Fork session/ }));

  assert.deepEqual(onForkSession.mock.calls, [[SESSION]]);
  assert.equal(onProjectSelect.mock.calls.length, 0);
  assert.equal(onSessionSelect.mock.calls.length, 0);
  assert.equal(screen.queryByRole('dialog'), null);
  assert.equal(screen.getByRole('button', { name: 'Session options for Session one' }).getAttribute('aria-expanded'), 'false');
});

test.each<LLMProvider>(['cursor', 'opencode'])('mobile withholds a fork when %s is unsupported or absent from the matrix', async (provider) => {
  render(<SidebarSessionItem {...rowProps({ session: { ...SESSION, __provider: provider } })} />);
  const sheet = await openOptions();

  assert.equal(sheet.queryByRole('button', { name: /Fork session/ }), null);
});

test('mobile withholds a fork when its caller provides no fork handler', async () => {
  render(<SidebarSessionItem {...rowProps({ onForkSession: undefined })} />);
  const sheet = await openOptions();

  assert.equal(sheet.queryByRole('button', { name: /Fork session/ }), null);
});

test('mobile withholds a fork while the session is running, including when it starts with the sheet open', async () => {
  const props = rowProps({ isProcessing: true });
  const { rerender } = render(<SidebarSessionItem {...props} />);
  const sheet = await openOptions();
  assert.equal(sheet.queryByRole('button', { name: /Fork session/ }), null);

  rerender(<SidebarSessionItem {...props} isProcessing={false} />);
  assert.ok(sheet.getByRole('button', { name: /Fork session/ }));

  rerender(<SidebarSessionItem {...props} />);
  assert.equal(sheet.queryByRole('button', { name: /Fork session/ }), null);
});

test('background work alone keeps the mobile fork available, matching the desktop rule', async () => {
  render(<SidebarSessionItem {...rowProps({ hasBackgroundWork: true })} />);
  const sheet = await openOptions();

  assert.ok(sheet.getByRole('button', { name: /Fork session/ }));
});

test('bulk selection withholds the mobile options trigger', () => {
  render(<SidebarSessionItem {...rowProps({ isSelecting: true })} />);

  assert.equal(screen.queryByRole('button', { name: 'Session options for Session one' }), null);
});
