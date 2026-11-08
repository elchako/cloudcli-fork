import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { ProviderModelOption } from '@/shared/types';
import { groupModelsByCatalogProvider } from '@/shared/modelProviderGroups';

const labels = { default: 'По умолчанию', unassigned: 'Без провайдера' };
const model = (value: string, catalogProvider?: string): ProviderModelOption => ({
  value, label: value, ...(catalogProvider ? { catalogProvider } : {}),
});

test('Gemini и Claude от Antigravity остаются в одной группе, GPT — в OpenAI', () => {
  const models = [model('default'), model('gpt-first', 'openai'), model('gemini-test', 'antigravity'),
    model('gpt-next', 'openai'), model('claude-test', 'antigravity'), model('custom')];
  const grouped = groupModelsByCatalogProvider(models, labels);
  assert.deepEqual(grouped.map(g => g.name), ['По умолчанию', 'OpenAI', 'Antigravity', 'Без провайдера']);
  assert.deepEqual(grouped.map(g => g.models.map(m => m.value)), [
    ['default'], ['gpt-first', 'gpt-next'], ['gemini-test', 'claude-test'], ['custom'],
  ]);
  assert.deepEqual(models.map(m => m.value), ['default', 'gpt-first', 'gemini-test', 'gpt-next', 'claude-test', 'custom']);
});

test('новый провайдер из API создаёт новую группу без изменения кода', () => {
  const groups = groupModelsByCatalogProvider([model('claude-new', 'new-vendor'), model('gpt-new', 'new-vendor')], labels);
  assert.equal(groups[0].name, 'new-vendor');
  assert.equal(groups[0].models.length, 2);
});

test('имена провайдеров не конфликтуют с ключами служебных групп и Object.prototype', () => {
  const groups = groupModelsByCatalogProvider([model('default'), model('x', 'default'), model('z', '__proto__')], labels);
  assert.deepEqual(groups.map(g => g.key), ['default', 'provider:default', 'provider:__proto__']);
  assert.equal(groups[2].name, '__proto__');
});

test('без owned_by остаётся плоский список, провайдер не выводится из префикса ID', () => {
  const models = [model('gpt-test'), model('gemini-test'), model('claude-test')];
  const groups = groupModelsByCatalogProvider(models, labels);
  assert.deepEqual(groups, [{ key: 'catalog', name: '', models }]);
});
