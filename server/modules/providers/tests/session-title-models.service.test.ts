import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection, initializeDatabase, userDb, userSettingsDb,
} from '@/modules/database/index.js';
import {
  buildSessionTitleModelRequest,
  createSessionTitleModelsService,
  isSessionTitleTextModel,
  SESSION_TITLE_MODELS_KEY,
} from '@/modules/providers/services/session-title-models.service.js';
import type { ApiModel } from '@/shared/small-model.js';

const PAIR = { primaryModel: 'text-primary', fallbackModel: 'text-fallback' };
const DEFAULT_CATALOG: ApiModel[] = [
  { id: PAIR.primaryModel, label: 'Основная' },
  { id: PAIR.fallbackModel, label: 'Резервная' },
  { id: 'legacy-haiku', label: 'Прежняя' },
];

function harness(options: {
  saved?: unknown;
  models?: ApiModel[] | null;
  backgroundUserId?: number;
} = {}) {
  const records = new Map<number, Record<string, unknown>>();
  if (options.saved !== undefined) records.set(1, { [SESSION_TITLE_MODELS_KEY]: options.saved });
  let models = options.models === undefined ? DEFAULT_CATALOG : options.models;
  let legacyReads = 0;
  const service = createSessionTitleModelsService({
    readSettings: (id) => records.get(id) ?? {},
    writeSettings: (id, patch) => records.set(id, { ...records.get(id), ...patch }),
    getBackgroundUserId: () => options.backgroundUserId ?? 1,
    getCatalog: async () => ({ models }),
    resolveLegacyModel: async () => { legacyReads += 1; return 'legacy-haiku'; },
  });
  return { service, records, legacyReads: () => legacyReads, setModels: (next: ApiModel[] | null) => { models = next; } };
}

test('явная пара имеет приоритет: Haiku и модель чата не участвуют', async () => {
  const { service, records, legacyReads } = harness({ saved: PAIR });
  records.set(1, { ...records.get(1), 'claude-model': 'chat-model', speechSummaryModel: 'summary-model' });
  assert.deepEqual(await service.resolveCandidates(), [{ model: PAIR.primaryModel }, { model: PAIR.fallbackModel }]);
  assert.equal(legacyReads(), 0);
});

test('отсутствующий основной ID пропускается, резервный остаётся', async () => {
  const { service, setModels } = harness({ saved: PAIR, models: [DEFAULT_CATALOG[1]!] });
  assert.deepEqual(await service.resolveCandidates(), [{ model: PAIR.fallbackModel }]);
  setModels([{ id: 'legacy-haiku', label: 'Прежняя' }]);
  assert.deepEqual(await service.resolveCandidates(), []);
});

test('повтор одного сохранённого ID не создаёт цикл fallback', async () => {
  const { service } = harness({ saved: { primaryModel: PAIR.primaryModel, fallbackModel: PAIR.primaryModel } });
  assert.deepEqual(await service.resolveCandidates(), [{ model: PAIR.primaryModel }]);
});

test('legacy используется только до явной настройки и только при подтверждении каталогом', async () => {
  const { service, setModels } = harness();
  assert.deepEqual(await service.resolveCandidates(), [{ model: 'legacy-haiku' }]);
  setModels(DEFAULT_CATALOG.slice(0, 2));
  assert.deepEqual(await service.resolveCandidates(), []);
  setModels(null);
  assert.deepEqual(await service.resolveCandidates(), []);
});

test('без настроенных доступных вариантов не выбирается первая модель API', async () => {
  const { service } = harness({ models: DEFAULT_CATALOG.slice(0, 2) });
  const status = await service.getStatus(1);
  assert.deepEqual(status.settings, { primaryModel: '', fallbackModel: '' });
  assert.equal(status.legacyModel, null);
  assert.deepEqual(await service.resolveCandidates(), []);
});

test('временная недоступность GET-каталога не удаляет явную пару', async () => {
  const { service } = harness({ saved: PAIR, models: null });
  assert.equal((await service.getStatus(1)).models, null);
  assert.deepEqual(await service.resolveCandidates(), [{ model: PAIR.primaryModel }, { model: PAIR.fallbackModel }]);
});

test('генераторы изображений и маски исключаются из настроек и цепочки', async () => {
  const imageIds = ['gpt-image-2', 'gemini-3-pro-image', 'imagen-4', 'flux-2', 'nano-banana-pro', 'dall-e-3', 'stable-diffusion-xl'];
  const masked = `claude-fable-5-dd-${[...'gpt-image-2'].reverse().join('')}`;
  for (const id of [...imageIds, masked]) assert.equal(isSessionTitleTextModel({ id, label: id }), false, id);
  const { service } = harness({
    saved: { ...PAIR, primaryModel: masked },
    models: [
      ...imageIds.map((id) => ({ id, label: id })),
      { id: masked, label: masked },
      { id: 'opaque', label: 'Image generator' },
      DEFAULT_CATALOG[1]!,
    ],
  });
  assert.deepEqual((await service.getStatus(1)).models, [DEFAULT_CATALOG[1]]);
  assert.deepEqual(await service.resolveCandidates(), [{ model: PAIR.fallbackModel }]);
});

test('effort берётся только из существующего подтверждённого каталога', () => {
  assert.deepEqual(buildSessionTitleModelRequest('gpt-6.1-sol', [{ id: 'gpt-6.1-sol', label: 'GPT' }]), { model: 'gpt-6.1-sol(low)' });
  const masked = `claude-fable-5-dd-${[...'gpt-6.1-sol'].reverse().join('')}`;
  assert.deepEqual(buildSessionTitleModelRequest(masked, [{ id: masked, label: 'GPT' }]), { model: `${masked}(low)` });
  assert.deepEqual(buildSessionTitleModelRequest('claude-sonnet-5-5', [{ id: 'claude-sonnet-5-5', label: 'Sonnet' }]), {
    model: 'claude-sonnet-5-5', adaptiveThinking: true, effort: 'low',
  });
  for (const id of ['gemini-text-unknown', 'gpt-unknown', 'claude-haiku-4-5-20251001', 'new-provider-text']) {
    assert.deepEqual(buildSessionTitleModelRequest(id), { model: id });
  }
});

test('сохранение пары мерджится с другими настройками и не обращается к credentials', async () => {
  const { service, records } = harness();
  records.set(1, { 'claude-model': 'chat-model', 'claude-effort': 'high' });
  assert.deepEqual(await service.save(1, { ...PAIR, apiKey: 'не сохранять', unrelated: true }), PAIR);
  assert.deepEqual(records.get(1), {
    'claude-model': 'chat-model', 'claude-effort': 'high', [SESSION_TITLE_MODELS_KEY]: PAIR,
  });
});

test('новые пустые, повторные, неизвестные и нетекстовые ID отклоняются', async () => {
  const { service, records } = harness();
  for (const input of [null, {}, { ...PAIR, primaryModel: 42 }, { ...PAIR, primaryModel: 'bad id' }, { ...PAIR, primaryModel: 'x'.repeat(257) }]) {
    await assert.rejects(service.save(1, input), { code: 'SESSION_TITLE_MODELS_REQUIRED' });
  }
  await assert.rejects(service.save(1, { ...PAIR, fallbackModel: PAIR.primaryModel }), { code: 'SESSION_TITLE_MODELS_DUPLICATE' });
  await assert.rejects(service.save(1, { ...PAIR, primaryModel: 'absent' }), { code: 'SESSION_TITLE_MODEL_UNAVAILABLE' });
  await assert.rejects(service.save(1, { ...PAIR, primaryModel: 'gpt-image-2' }), { code: 'SESSION_TITLE_MODEL_NOT_TEXT' });
  assert.equal(records.size, 0);
});

test('метка image в API тоже запрещает модель с непрозрачным ID', async () => {
  const { service } = harness({ models: [...DEFAULT_CATALOG, { id: 'opaque', label: 'Image generator' }] });
  await assert.rejects(service.save(1, { ...PAIR, primaryModel: 'opaque' }), { code: 'SESSION_TITLE_MODEL_NOT_TEXT' });
});

test('исчезнувший сохранённый основной ID не мешает заменить резервный', async () => {
  const { service, records } = harness({ saved: { ...PAIR, fallbackModel: 'old-fallback' }, models: [DEFAULT_CATALOG[1]!] });
  assert.deepEqual(await service.save(1, PAIR), PAIR);
  assert.deepEqual(records.get(1)?.[SESSION_TITLE_MODELS_KEY], PAIR);
});

test('новый ID нельзя сохранить при недоступном каталоге, существующие не теряются', async () => {
  const { service, records } = harness({ saved: PAIR, models: null });
  await assert.rejects(service.save(1, { ...PAIR, fallbackModel: 'new-model' }), { code: 'SESSION_TITLE_CATALOG_UNAVAILABLE' });
  assert.deepEqual(records.get(1)?.[SESSION_TITLE_MODELS_KEY], PAIR);
  assert.deepEqual(await service.save(1, PAIR), PAIR);
});

test('фоновая и ручная генерация читают настройки соответствующего пользователя', async () => {
  const { service, records } = harness({ saved: PAIR, backgroundUserId: 2 });
  records.set(2, { [SESSION_TITLE_MODELS_KEY]: { primaryModel: PAIR.fallbackModel, fallbackModel: PAIR.primaryModel } });
  assert.deepEqual(await service.resolveCandidates(), [{ model: PAIR.fallbackModel }, { model: PAIR.primaryModel }]);
  assert.deepEqual(await service.resolveCandidates(1), [{ model: PAIR.primaryModel }, { model: PAIR.fallbackModel }]);
});

test('явная пара переживает новое подключение и другой экземпляр сервиса', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'title-model-settings-'));
  const previousPath = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  try {
    await initializeDatabase();
    const userId = Number(userDb.createUser('title-settings-user', 'test-hash').id);
    const dependencies = {
      readSettings: (id: number) => userSettingsDb.getSettings(id),
      writeSettings: (id: number, patch: Record<string, unknown>) => userSettingsDb.updateSettings(id, patch, true),
      getBackgroundUserId: () => userId,
      getCatalog: async () => ({ models: DEFAULT_CATALOG }),
      resolveLegacyModel: async () => 'legacy-haiku',
    };
    await createSessionTitleModelsService(dependencies).save(userId, PAIR);
    closeConnection();
    await initializeDatabase();
    const otherDevice = createSessionTitleModelsService(dependencies);
    assert.deepEqual((await otherDevice.getStatus(userId)).settings, PAIR);
    assert.deepEqual(await otherDevice.resolveCandidates(), [{ model: PAIR.primaryModel }, { model: PAIR.fallbackModel }]);
  } finally {
    closeConnection();
    if (previousPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
