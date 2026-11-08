import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ApiModel } from '@/shared/small-model.js';

import {
  createImageGenerationSettingsService, defaultImageSettings, imageCatalogModels,
  IMAGE_GENERATION_SETTINGS_KEY,
} from '../image-generation-settings.service.js';

function setup() {
  const rows = new Map<number, Record<string, unknown>>();
  let catalog: ApiModel[] | null = [
    { id: 'gpt-image-2.6', label: 'GPT Image 2.6', catalogProvider: 'openai' },
    { id: 'gpt-image-2.6-flare', label: 'Flare' },
    { id: 'gpt-image-2.6-sunburst', label: 'Sunburst' },
    { id: 'claude-haiku-5-5', label: 'Haiku' },
  ];
  const refreshed: boolean[] = [];
  const service = createImageGenerationSettingsService({
    readSettings: (id) => rows.get(id) ?? {},
    writeSettings: (id, patch) => rows.set(id, { ...rows.get(id), ...patch }),
    getCatalog: async (force) => { refreshed.push(Boolean(force)); return { models: catalog }; },
    resolveDefaultModel: async () => 'gpt-image-2.6',
  });
  return { service, rows, refreshed, catalog: (value: ApiModel[] | null) => { catalog = value; } };
}

test('профили имеют независимые настройки качества, без угадывания свойств Flare/Sunburst', async () => {
  const { service } = setup();
  const status = await service.getStatus(1);
  assert.deepEqual(status.settings, defaultImageSettings('gpt-image-2.6'));
  assert.equal(status.models?.length, 3);
  assert.equal(status.settings.defaultProfile, 'standard');
  assert.equal(status.settings.profiles.draft.quality, 'low');
  assert.equal(status.settings.profiles.final.quality, 'high');
});

test('маски API превращаются в настоящие image-ID и дедуплицируются', () => {
  const id = 'gpt-image-2.6';
  assert.deepEqual(imageCatalogModels([
    { id: `claude-fable-5-dd-${[...id].reverse().join('')}`, label: 'GPT Image', catalogProvider: 'openai' },
    { id, label: id },
    { id: 'nano-banana', label: 'Nano Banana' },
  ]), [{ id, label: 'GPT Image', catalogProvider: 'openai' }]);
  assert.equal(imageCatalogModels(null), null);
});

test('сохранение относится к аккаунту и не стирает другие настройки', async () => {
  const { service, rows } = setup();
  rows.set(7, { language: 'ru' });
  const next = defaultImageSettings('gpt-image-2.6');
  next.defaultProfile = 'draft';
  next.profiles.final.model = 'gpt-image-2.6-sunburst';
  await service.save(7, next);
  assert.equal(rows.get(7)?.language, 'ru');
  assert.deepEqual(rows.get(7)?.[IMAGE_GENERATION_SETTINGS_KEY], next);
  assert.deepEqual(await service.resolve(7), { profile: 'draft', ...next.profiles.draft });
  assert.equal((await service.resolve(8)).profile, 'standard');
  assert.deepEqual(await service.resolve(7, 'final'), { profile: 'final', ...next.profiles.final });
  next.profiles.final.model = 'gpt-image-2.6-flare';
  await service.save(7, next);
  assert.equal((await service.resolve(7, 'final')).model, 'gpt-image-2.6-flare');
});

test('обновление каталога явное, без сброса выбранных моделей', async () => {
  const { service, refreshed } = setup();
  await service.getStatus(1, true);
  assert.deepEqual(refreshed, [true]);
});

test('новая версия доступна без изменения списка в коде', async () => {
  const { service, catalog } = setup();
  catalog([{ id: 'gpt-image-9.1', label: 'Новая' }]);
  const next = defaultImageSettings('gpt-image-9.1');
  await service.save(1, next);
  assert.equal((await service.resolve(1)).model, 'gpt-image-9.1');
});

test('модель вне каталога не сохраняется, даже если похожа на GPT Image', async () => {
  const { service, rows } = setup();
  await assert.rejects(service.save(1, defaultImageSettings('gpt-image-unknown')), /отсутствует/);
  assert.equal(rows.size, 0);
});

test('исчезнувшую модель не заменяет другой профиль, но позволяет исправить одну настройку', async () => {
  const { service, catalog } = setup();
  const next = defaultImageSettings('gpt-image-2.6');
  next.profiles.final.model = 'gpt-image-2.6-sunburst';
  await service.save(1, next);
  catalog([{ id: 'gpt-image-2.6', label: 'GPT' }]);
  await assert.rejects(service.resolve(1, 'final'), /недоступна/);
  next.profiles.draft.quality = 'medium';
  await service.save(1, next);
  assert.equal((await service.getStatus(1)).settings.profiles.final.model, 'gpt-image-2.6-sunburst');
});

test('недоступный каталог не сбрасывает явно сохранённые ID', async () => {
  const { service, catalog } = setup();
  const next = defaultImageSettings('gpt-image-2.6');
  await service.save(1, next);
  catalog(null);
  assert.deepEqual((await service.getStatus(1)).settings, next);
  assert.equal((await service.resolve(1)).model, 'gpt-image-2.6');
  next.profiles.final.model = 'gpt-image-2.6-flare';
  await assert.rejects(service.save(1, next), /отсутствует/);
});

test('валидирует весь профиль, а не только текущий режим', async () => {
  const { service } = setup();
  for (const invalid of [null, {}, { ...defaultImageSettings('gpt-image-2.6'), defaultProfile: 'expensive' },
    { defaultProfile: 'standard', profiles: { draft: { model: 'gpt-image-2.6', quality: 'low' } } },
    defaultImageSettings('claude-haiku-5-5'), defaultImageSettings('gpt-image-2.6\nsecret')]) {
    await assert.rejects(service.save(1, invalid));
  }
});

test('ошибка чтения БД не приводит к генерации через общие defaults', async () => {
  const service = createImageGenerationSettingsService({
    readSettings: () => { throw new Error('database'); }, writeSettings: () => {},
    getCatalog: async () => ({ models: [] }), resolveDefaultModel: async () => 'gpt-image-2.6',
  });
  await assert.rejects(service.resolve(7), /database/);
});
