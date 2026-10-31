import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import { test, vi } from 'vitest';

import type { ProviderModelOption } from '@/shared/types';
import '@/modules/i18n';
import ComposerModelMenu from '@/modules/chat/composer/ComposerModelMenu';

const MODELS: ProviderModelOption[] = [
  { value: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', isCustom: false },
  { value: 'claude-sonnet-5-5[1m]', label: 'Sonnet 5.5 (1M context)', isCustom: false },
  { value: 'custom-model', label: 'Пользовательская модель с очень длинным названием', isCustom: true },
];

const renderMenu = (model: string, onSelectModel = vi.fn()) => render(
  <ComposerModelMenu
    effort="high"
    effortOptions={[{ value: 'high' }, { value: 'max' }]}
    onSelectEffort={() => {}}
    model={model}
    modelOptions={MODELS}
    onSelectModel={onSelectModel}
    modelsLoading={false}
  />,
);

test('название доступно от 360 px и сохраняется целиком в подсказке', () => {
  for (const model of MODELS) {
    const { getByRole, unmount } = renderMenu(model.value);
    const trigger = getByRole('button', { name: `Select model and reasoning effort: ${model.label}` });
    const label = trigger.querySelector('span');
    assert.equal(label?.textContent, model.label);
    assert.ok(label?.classList.contains('truncate'));
    assert.ok(label?.classList.contains('min-[360px]:inline'));
    assert.ok(trigger.querySelector('svg')?.classList.contains('min-[360px]:hidden'));
    if (model.label.endsWith(' (1M context)')) {
      assert.equal(label?.firstChild?.textContent, model.label.replace(/\s+\(1M context\)$/, ''));
      assert.equal(label?.querySelector('span.hidden.sm\\:inline')?.textContent, ' (1M context)');
    }
    assert.equal(trigger.classList.contains('shrink-0'), false);
    assert.ok(trigger.title.endsWith(model.label));
    unmount();
  }
});

test('неизвестная модель отображается по ID', () => {
  const { getByRole } = renderMenu('gateway/new-model');
  assert.ok(getByRole('button', { name: /gateway\/new-model$/ }));
});

test('модель выбирается в портальном меню после pointerdown', () => {
  const onSelectModel = vi.fn();
  const { getByRole, queryByRole } = renderMenu(MODELS[0].value, onSelectModel);
  fireEvent.click(getByRole('button'));
  fireEvent.click(getByRole('menuitem', { name: MODELS[0].label }));
  const item = getByRole('menuitemradio', { name: MODELS[1].label });
  fireEvent.pointerDown(item);
  fireEvent.click(item);
  assert.deepEqual(onSelectModel.mock.calls, [[MODELS[1].value]]);
  assert.equal(queryByRole('menu'), null);
});
