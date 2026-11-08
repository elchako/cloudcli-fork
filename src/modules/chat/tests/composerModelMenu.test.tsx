import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import { test, vi } from 'vitest';

import type { ProviderModelOption } from '@/shared/types';
import { DEFAULT_EFFORT_VALUE } from '@/shared/constants';
import '@/modules/i18n';
import ComposerModelMenu from '@/modules/chat/composer/ComposerModelMenu';

const MODELS: ProviderModelOption[] = [
  { value: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', isCustom: false },
  { value: 'claude-sonnet-5-5[1m]', label: 'Sonnet 5.5 (1M context)', isCustom: false },
  { value: 'gemini-3.8-flash-high', label: 'gemini-3.8-flash-high', isCustom: false },
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

// GOLDJAXE fork (реестр §4.17): имя сокращается отдельно от несжимаемого effort.
test('название не переименовывается и сокращается отдельно от effort на любой ширине', () => {
  for (const model of MODELS) {
    const { getByRole, unmount } = renderMenu(model.value);
    const trigger = getByRole('button', { name: `Select model and reasoning effort: ${model.label} · high` });
    const label = trigger.querySelector('span');
    assert.equal(label?.textContent, model.label);
    assert.ok(label?.classList.contains('truncate'));
    assert.ok(label?.classList.contains('min-w-0'));
    assert.equal(label?.classList.contains('hidden'), false);
    const effort = trigger.querySelector('span.shrink-0');
    assert.equal(effort?.querySelector('.sm\\:hidden')?.textContent, 'H');
    assert.equal(effort?.classList.contains('hidden'), false);
    assert.equal(effort?.classList.contains('truncate'), false);
    assert.equal(trigger.classList.contains('shrink-0'), false);
    assert.equal(trigger.title, `Select model and reasoning effort: ${model.label} · high`);
    unmount();
  }
});

test('неизвестная модель отображается по исходному ID', () => {
  const { getByRole } = renderMenu('gateway/new-model');
  assert.ok(getByRole('button', { name: /gateway\/new-model · high$/ }));
});

test.each([
  ['low', 'L'], ['medium', 'M'], ['high', 'H'], ['xhigh', 'XH'], ['max', 'Max'],
  [DEFAULT_EFFORT_VALUE, 'Auto'], ['custom-effort', 'custom-effort'],
])('уровень %s имеет краткую подпись %s, но полное название в меню', (effort, compact) => {
  const onSelectEffort = vi.fn();
  const { getByRole } = render(
    <ComposerModelMenu
      effort={effort}
      effortOptions={[{ value: effort === DEFAULT_EFFORT_VALUE ? 'high' : effort }]}
      onSelectEffort={onSelectEffort}
      model={MODELS[0].value}
      modelOptions={MODELS}
      onSelectModel={() => {}}
      modelsLoading={false}
    />,
  );
  const trigger = getByRole('button');
  assert.equal(trigger.querySelector('.sm\\:hidden')?.textContent, compact);
  fireEvent.click(trigger);
  const item = getByRole('menuitemradio', { name: effort === DEFAULT_EFFORT_VALUE ? 'Default' : effort });
  fireEvent.pointerDown(item);
  fireEvent.click(item);
  assert.deepEqual(onSelectEffort.mock.calls, [[effort]]);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
});

test('у модели без уровней effort нет выдуманного индикатора', () => {
  const { getByRole } = render(
    <ComposerModelMenu effort="high" effortOptions={[]} onSelectEffort={() => {}}
      model={MODELS[0].value} modelOptions={MODELS} onSelectModel={() => {}} modelsLoading={false} />,
  );
  const trigger = getByRole('button');
  assert.equal(trigger.textContent, MODELS[0].label);
  assert.equal(trigger.querySelector('span.shrink-0'), null);
});

test.each(['unknown', 'unsupported'] as const)('состояние %s объясняется, а не маскируется под доступные уровни', (reasoningStatus) => {
  const { getByRole, getByText, queryByRole } = render(<ComposerModelMenu effort="default" effortOptions={[]} onSelectEffort={() => {}}
    model="future" modelOptions={[{ value: 'future', label: 'Future', reasoningStatus }]} onSelectModel={() => {}} modelsLoading={false} />);
  const button = getByRole('button');
  assert.equal(button.textContent?.includes('?'), reasoningStatus === 'unknown');
  fireEvent.click(button);
  assert.ok(getByText(reasoningStatus === 'unknown'
    ? 'The API has not reported reasoning levels. The provider default is used.'
    : 'This model has no selectable reasoning levels.'));
  assert.equal(queryByRole('menuitemradio', { name: 'low' }), null);
});

test('меню группирует модели по провайдеру API и передаёт исходный ID после тача', () => {
  const onSelectModel = vi.fn();
  const { getByRole } = render(<ComposerModelMenu effort="high" effortOptions={[{ value: 'high' }]}
    onSelectEffort={() => {}} model="gpt-fixture" modelsLoading={false} onSelectModel={onSelectModel}
    modelOptions={[
      { value: 'gpt-fixture', label: 'GPT Fixture', catalogProvider: 'openai' },
      { value: 'gemini-fixture', label: 'Gemini Fixture', catalogProvider: 'antigravity' },
      { value: 'claude-fixture', label: 'Claude Fixture', catalogProvider: 'antigravity' },
    ]} />);
  fireEvent.click(getByRole('button'));
  fireEvent.click(getByRole('menuitem', { name: 'GPT Fixture' }));
  const group = getByRole('group', { name: 'Antigravity' });
  assert.ok(group.textContent?.includes('Gemini Fixture'));
  assert.ok(group.textContent?.includes('Claude Fixture'));
  assert.equal(group.textContent?.includes('GPT Fixture'), false);
  const target = getByRole('menuitemradio', { name: 'Claude Fixture' });
  fireEvent.pointerDown(target);
  fireEvent.click(target);
  assert.deepEqual(onSelectModel.mock.calls, [['claude-fixture']]);
});

test('модель выбирается в прежнем портальном меню после pointerdown', () => {
  const onSelectModel = vi.fn();
  const { getByRole, queryByRole } = renderMenu(MODELS[0].value, onSelectModel);
  fireEvent.click(getByRole('button'));
  assert.ok(getByRole('menuitemradio', { name: 'high' }));
  assert.equal(queryByRole('menuitemradio', { name: MODELS[1].label }), null);
  fireEvent.click(getByRole('menuitem', { name: MODELS[0].label }));
  const item = getByRole('menuitemradio', { name: MODELS[1].label });
  fireEvent.pointerDown(item);
  fireEvent.click(item);
  assert.deepEqual(onSelectModel.mock.calls, [[MODELS[1].value]]);
  assert.equal(queryByRole('menu'), null);
});
