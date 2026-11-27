import assert from 'node:assert/strict';

import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type { AppTab, Project, ProjectSession } from '@/shared/types';

vi.mock('@/modules/plugins', () => ({
  usePlugins: () => ({ plugins: [
    { name: 'monitor', displayName: 'Agent Monitor', icon: 'activity.svg', enabled: true },
    { name: 'disabled', displayName: 'Disabled plugin', icon: 'empty.svg', enabled: false },
  ] }),
  PluginIcon: () => null,
}));
vi.mock('@/modules/project-workspace/WorkspaceConnectionStatus', () => ({ default: () => null }));

const { default: WorkspaceHeader } = await import('@/modules/project-workspace/WorkspaceHeader');
const project: Project = { projectId: 'demo', fullPath: '/demo', displayName: 'Demo' };
const session: ProjectSession = { id: 'chat-1', summary: 'A chat with a long title', __provider: 'claude' };

function Header({ mobile, extraTools = true }: { mobile: boolean; extraTools?: boolean }) {
  const [activeTab, setActiveTab] = useState<AppTab>('chat');
  return <WorkspaceHeader
    activeTab={activeTab}
    setActiveTab={setActiveTab}
    selectedProject={project}
    selectedSession={session}
    shouldShowTasksTab={extraTools}
    shouldShowBrowserTab={extraTools}
    isMobile={mobile}
    onMenuClick={() => {}}
    onRenameSession={async () => true}
  />;
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => vi.unstubAllGlobals());

// GOLDJAXE fork (реестр §12.5): тот же набор представлений, один вход на телефоне.
test('мобильная шапка оставляет заголовок и одну кнопку, меню переключает все доступные представления', () => {
  render(<Header mobile />);
  assert.equal(screen.queryAllByRole('tab').length, 0);
  assert.equal(screen.getByRole('heading', { name: session.summary }).textContent, session.summary);
  const trigger = screen.getByRole('button', { name: 'Tools' });
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  fireEvent.click(trigger);
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(screen.getAllByRole('menuitem').map((item) => item.textContent), [
    'Chat', 'Shell', 'Files', 'Source Control', 'Browser', 'Tasks', 'Agent Monitor',
  ]);
  assert.equal(screen.getByRole('menuitem', { name: 'Chat' }).getAttribute('aria-current'), 'true');

  fireEvent.scroll(screen.getByRole('menu'));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Agent Monitor' }));
  assert.equal(screen.queryAllByRole('menu').length, 0);
  assert.equal(screen.getByRole('heading', { name: 'Agent Monitor' }).textContent, 'Agent Monitor');
  assert.equal(document.activeElement === trigger, true);
  fireEvent.click(trigger);
  assert.equal(screen.getByRole('menuitem', { name: 'Agent Monitor' }).getAttribute('aria-current'), 'true');
  fireEvent.click(screen.getByRole('menuitem', { name: 'Chat' }));
  assert.equal(screen.getByRole('heading', { name: session.summary }).textContent, session.summary);
});

test('меню не показывает отключённые инструменты, а десктоп сохраняет вкладки и выбранный экран', () => {
  const view = render(<Header mobile extraTools={false} />);
  const trigger = screen.getByRole('button', { name: 'Tools' });
  fireEvent.click(trigger);
  assert.equal(screen.queryAllByRole('menuitem', { name: 'Browser' }).length, 0);
  assert.equal(screen.queryAllByRole('menuitem', { name: 'Tasks' }).length, 0);
  fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Chat' }), { key: 'Escape' });
  assert.equal(screen.queryAllByRole('menu').length, 0);
  assert.equal(document.activeElement === trigger, true);
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Files' }));

  view.rerender(<Header mobile={false} extraTools={false} />);
  assert.equal(screen.queryAllByRole('button', { name: 'Tools' }).length, 0);
  assert.equal(screen.getAllByRole('tab').length, 5);
  assert.equal(screen.getByRole('tab', { name: 'Files' }).getAttribute('aria-selected'), 'true');
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Files' }), { key: 'ArrowRight' });
  assert.equal(screen.getByRole('tab', { name: 'Source Control' }).getAttribute('aria-selected'), 'true');
});
