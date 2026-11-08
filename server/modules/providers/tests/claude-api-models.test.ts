import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';

import { createClaudeApiModelCatalog, decodeCliProxyModelId } from '@/modules/providers/list/claude/claude-api-models.js';
import { CLAUDE_PREDEFINED_MODELS, ClaudeProviderModels, withGatewayEffortSuffix, withoutGatewayEffortSuffix } from '@/modules/providers/list/claude/claude-models.provider.js';
import type { ApiModel, SmallModelCredentials } from '@/shared/small-model.js';

const credentials: SmallModelCredentials = { baseUrl: 'https://api.example.invalid', token: 'fixture-secret-only', isApiKey: true };
const row = (id: string): ApiModel => ({ id, label: `Модель ${id}` });
const mask = (id: string) => `claude-fable-5-dd-${[...id].reverse().join('')}`;

function gate<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { release = resolve; });
  return { promise, release };
}

test('без API credentials остаётся прежний запасной каталог и нет сетевого вызова', async () => {
  let loads = 0;
  const cache = createClaudeApiModelCatalog({ resolveCredentials: async () => null, loadModels: async () => { loads++; return []; } });
  const models = await new ClaudeProviderModels(cache).getSupportedModels();
  assert.equal(models, CLAUDE_PREDEFINED_MODELS);
  assert.equal(loads, 0);
});

test('каталог API допускает неизвестный ID и имя, не добавляет отсутствующие статические модели', async () => {
  const id = 'new-vendor/model-v12';
  const wrapped = mask('gpt-6.1-sol');
  const provider = new ClaudeProviderModels({ get: async () => ({ models: [row(id), { id: wrapped, label: 'GPT Sol API' }], source: 'api' }) });
  const models = await provider.getSupportedModels();
  assert.deepEqual(models.OPTIONS.map((m) => m.value), ['default', id, wrapped]);
  assert.equal(models.DEFAULT, 'default');
  assert.equal(models.SOURCE, 'api');
  assert.equal(models.OPTIONS[1].label, `Модель ${id}`);
  assert.equal(models.OPTIONS[1].effort, undefined, 'не выдумываем возможности неизвестной модели');
  assert.deepEqual(models.OPTIONS[2].effort?.values.map((e) => e.value), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.ok(!models.OPTIONS.some((m) => m.value === 'claude-fable-5-1[1m]'));
});

test('имя известной модели не приписывает 1M контекст ID без соответствующего суффикса', async () => {
  const provider = new ClaudeProviderModels({ get: async () => ({ models: [{ id: 'claude-opus-5-5', label: 'claude-opus-5-5' }], source: 'api' }) });
  const models = await provider.getSupportedModels();
  assert.equal(models.OPTIONS[1].value, 'claude-opus-5-5');
  assert.equal(models.OPTIONS[1].label.includes('1M'), false);
});

test('штатный default из API не дублируется и выбор не заменяется первым ID', async () => {
  const provider = new ClaudeProviderModels({ get: async () => ({ models: [row('new-model'), row('default')], source: 'api' }) });
  const models = await provider.getSupportedModels();
  assert.equal(models.OPTIONS.filter((m) => m.value === 'default').length, 1);
  assert.equal(models.DEFAULT, 'default');
});

test('одновременные обращения делят один запрос и кэш не выдаёт общий изменяемый массив', async () => {
  let loads = 0;
  const pending = gate<ApiModel[]>();
  const cache = createClaudeApiModelCatalog({
    resolveCredentials: async () => credentials,
    loadModels: async (_credentials, options) => { loads++; assert.equal(options.timeoutMs, 3000); return pending.promise; },
  });
  const a = cache.get(), b = cache.get();
  await nextTurn();
  assert.equal(loads, 1);
  pending.release([row('first')]);
  const [left, right] = await Promise.all([a, b]);
  assert.deepEqual(left, right);
  left.models![0].label = 'Изменено вызывающим';
  assert.notEqual((await cache.get()).models![0].label, left.models![0].label);
  assert.equal(loads, 1);
});

test('просроченный каталог возвращается сразу, пока фоновый запрос обновляет его', async () => {
  let clock = 0, loads = 0;
  const pending = gate<ApiModel[]>();
  const cache = createClaudeApiModelCatalog({
    now: () => clock, resolveCredentials: async () => credentials,
    loadModels: async () => ++loads === 1 ? [row('old')] : pending.promise,
  });
  await cache.get();
  clock = 310_000;
  const stale = await cache.get();
  assert.equal(stale.source, 'api-cache');
  assert.equal(stale.models![0].id, 'old');
  assert.equal(loads, 2);
  pending.release([row('new')]);
  await nextTurn();
  const fresh = await cache.get();
  assert.equal(fresh.source, 'api');
  assert.equal(fresh.models![0].id, 'new');
});

test('явное обновление обходит TTL, а сбой сохраняет последний успешный каталог', async () => {
  let loads = 0;
  const answers = [[row('one')], [row('two')], null];
  const cache = createClaudeApiModelCatalog({ resolveCredentials: async () => credentials, loadModels: async () => answers[loads++] });
  await cache.get();
  assert.equal((await cache.refresh()).models![0].id, 'two');
  const failed = await cache.refresh();
  assert.equal(failed.source, 'api-cache');
  assert.equal(failed.models![0].id, 'two');
  await cache.get();
  assert.equal(loads, 3, 'ошибка не создаёт запрос при каждом обращении');
});

test('пустой или невалидный первый ответ даёт явно помеченный fallback', async () => {
  let loads = 0;
  const cache = createClaudeApiModelCatalog({ resolveCredentials: async () => credentials, loadModels: async () => { loads++; return []; } });
  const models = await new ClaudeProviderModels(cache).getSupportedModels();
  assert.equal(models.SOURCE, 'fallback');
  assert.equal(models.OPTIONS, CLAUDE_PREDEFINED_MODELS.OPTIONS);
  await cache.get();
  assert.equal(loads, 1);
});

test('ошибка подменённого транспорта также обрабатывается без unhandled rejection', async () => {
  const cache = createClaudeApiModelCatalog({ resolveCredentials: async () => credentials, loadModels: async () => { throw new Error('fixture failure'); } });
  assert.deepEqual(await cache.get(), { models: null, source: 'fallback' });
});

test('смена ключа или endpoint не использует каталог прежнего подключения', async () => {
  let active = credentials, loads = 0;
  const cache = createClaudeApiModelCatalog({ resolveCredentials: async () => active, loadModels: async () => [row(String(++loads))] });
  assert.equal((await cache.get()).models![0].id, '1');
  active = { ...credentials, token: 'other-fixture-key' };
  assert.equal((await cache.get()).models![0].id, '2');
  active = { ...active, baseUrl: 'https://other.example.invalid' };
  const response = await cache.get();
  assert.equal(response.models![0].id, '3');
  assert.ok(!JSON.stringify(response).includes('fixture-key'));
  assert.ok(!JSON.stringify(response).includes('example.invalid'));
});

test('поздний ответ старого подключения не перезаписывает новый кэш', async () => {
  let active = credentials;
  const pending = gate<ApiModel[]>();
  const cache = createClaudeApiModelCatalog({
    resolveCredentials: async () => active,
    loadModels: async (c) => c.token === credentials.token ? pending.promise : [row('new-account')],
  });
  const old = cache.get();
  await nextTurn();
  active = { ...credentials, token: 'rotated-fixture-key' };
  assert.equal((await cache.get()).models![0].id, 'new-account');
  pending.release([row('old-account')]);
  await old;
  assert.equal((await cache.get()).models![0].id, 'new-account');
});

test('маскированный GPT сохраняет исходный ID, effort и обратное снятие суффикса', () => {
  const id = mask('gpt-6.1-sol');
  assert.equal(decodeCliProxyModelId(id), 'gpt-6.1-sol');
  assert.equal(withGatewayEffortSuffix(id, 'max'), `${id}(max)`);
  assert.equal(withGatewayEffortSuffix(`${id}(high)`, 'max'), `${id}(high)`);
  assert.equal(withoutGatewayEffortSuffix(`${id}(max)`), id);
  assert.equal(withGatewayEffortSuffix(mask('kimi-k3[1m]'), 'high'), mask('kimi-k3[1m]'));
});
