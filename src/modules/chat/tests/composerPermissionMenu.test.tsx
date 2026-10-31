import assert from 'node:assert/strict';

import { act, fireEvent, render } from '@testing-library/react';
import { test, vi } from 'vitest';

import type { PermissionMode } from '@/shared/types';
import { i18n } from '@/modules/i18n';
import frChat from '@/modules/i18n/locales/fr/chat.json';
import ComposerPermissionMenu from '@/modules/chat/composer/ComposerPermissionMenu';

const MODES = ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'] as const;

const renderMenu = (permissionMode: PermissionMode, permissionModes: PermissionMode[] = [...MODES]) =>
  render(
    <ComposerPermissionMenu
      permissionMode={permissionMode}
      permissionModes={permissionModes}
      onSelectPermissionMode={() => {}}
      providerLabel="Claude"
    />,
  );

test('все режимы показаны только значком, с полным доступным именем и подсказкой', () => {
  const unknownMode = 'dontAsk' as PermissionMode;
  const expected: Array<[PermissionMode, string]> = [
    ['default', 'Default Mode'],
    ['auto', 'Auto Mode'],
    ['acceptEdits', 'Accept Edits'],
    ['bypassPermissions', 'Bypass Permissions'],
    ['plan', 'Plan Mode'],
    [unknownMode, 'dontAsk'],
  ];

  for (const [mode, name] of expected) {
    const { getByRole, unmount } = renderMenu(mode, [...MODES, unknownMode]);
    const trigger = getByRole('button', { name: new RegExp(`^${name}: `) });
    assert.equal(trigger.textContent, '');
    assert.ok(trigger.querySelector('svg[aria-hidden="true"]'));
    assert.ok(trigger.classList.contains('w-8'));
    assert.ok(trigger.title.startsWith(`${name} — `));
    unmount();
  }
});

test('без поддерживаемых режимов кнопка не отображается', () => {
  const { queryByRole } = renderMenu('default', []);
  assert.equal(queryByRole('button'), null);
});

test('подсказка и меню локализованы', async () => {
  await act(async () => {
    await i18n.changeLanguage('fr');
  });
  try {
    const { getByRole, getAllByRole } = renderMenu('plan');
    const trigger = getByRole('button');
    const heading = frChat.composer.permissionHeading.replace('{{provider}}', 'Claude');

    assert.equal(trigger.textContent, '');
    assert.ok(trigger.title.startsWith(`${frChat.codex.modes.plan} — `));
    assert.equal(
      trigger.getAttribute('aria-label'),
      frChat.composer.permissionTriggerLabel.replace('{{mode}}', frChat.codex.modes.plan).replace('{{heading}}', heading),
    );

    fireEvent.click(trigger);
    const rows = getAllByRole('menuitemradio');
    assert.equal(rows.length, MODES.length);
    MODES.forEach((mode, index) => {
      assert.ok(rows[index].textContent?.startsWith(frChat.codex.modes[mode]));
    });
    assert.equal(getByRole('menu').lastElementChild?.textContent, frChat.composer.permissionCycleHint);
  } finally {
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  }
});

test('выбор режима в портальном меню работает после pointerdown и закрывает меню', () => {
  const onSelectPermissionMode = vi.fn();
  const { getByRole, queryByRole } = render(
    <ComposerPermissionMenu
      permissionMode="default"
      permissionModes={[...MODES]}
      onSelectPermissionMode={onSelectPermissionMode}
      providerLabel="Claude"
    />,
  );
  const trigger = getByRole('button');
  fireEvent.click(trigger);
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  const item = getByRole('menuitemradio', { name: /Bypass Permissions/ });
  fireEvent.pointerDown(item);
  fireEvent.click(item);
  assert.deepEqual(onSelectPermissionMode.mock.calls, [['bypassPermissions']]);
  assert.equal(queryByRole('menu'), null);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
});

test('меню напоминает о переключении режима через Tab', () => {
  const { getByRole } = renderMenu('default');
  fireEvent.click(getByRole('button'));
  assert.equal(getByRole('menu').lastElementChild?.textContent, 'Press Tab in the message box to switch modes');
});
