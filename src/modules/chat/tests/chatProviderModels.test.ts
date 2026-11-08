import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { resetUserPreferences, writeUserPreference } from '@/shared/userSettings';

/**
 * The four per-provider default models used to be four useState slots with four
 * copy-pasted reconciliation effects and a four-branch setter. They are now one
 * Record with one loop. These tests pin the behaviour that has to survive that:
 * each provider keeps its own model, under its own storage key, and choosing a
 * model persists it.
 */

const okJson = (data: unknown) => Promise.resolve({
  ok: true,
  json: async () => data,
});

vi.mock('@/shared/api', () => ({
  api: {
    // The preference store PATCHes through api.user; it is stubbed rather than
    // exercised here, which keeps these tests about the model record.
    user: {
      preferences: () => okJson({ success: true, preferences: {} }),
      savePreferences: () => okJson({ success: true, preferences: {} }),
    },
    providers: {
      models: () => okJson({ success: true, data: null }),
      capabilities: () => okJson({ success: true, data: null }),
      sessionActiveModel: () => okJson({ success: true, data: null }),
      setSessionActiveModel: () => okJson({ success: true, data: null }),
      setSessionActiveEffort: () => okJson({ success: true, data: null }),
      createModel: () => okJson({ success: true, data: null }),
      updateModel: () => okJson({ success: true, data: null }),
      removeModel: () => okJson({ success: true, data: null }),
    },
  },
}));

const renderProviderState = async () => {
  const { useChatProviderState } = await import(
    '@/modules/chat/hooks/useChatProviderState'
  );
  return renderHook(() =>
    useChatProviderState({ selectedSession: null, selectedProject: null }),
  );
};

beforeEach(() => {
  localStorage.clear();
  // The preference store is a module-level singleton, so its in-memory copy
  // outlives localStorage.clear() and would leak one test's writes into the next.
  resetUserPreferences();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

const apiModelsResponse = (ids: string[]) => new Response(JSON.stringify({ success: true, data: { models: {
  OPTIONS: ids.map((value) => ({ value, label: value })), DEFAULT: ids[0], SOURCE: 'api',
} } }), { headers: { 'Content-Type': 'application/json' } });

// GOLDJAXE fork (реестр §22): неизвестные ID и ручное обновление не требуют новой сборки.
test('обновление API добавляет неизвестную модель, которую можно выбрать без подстановки ID', async () => {
  const { api } = await import('@/shared/api');
  const calls: Array<[string, boolean | undefined]> = [];
  vi.spyOn(api.providers, 'models').mockImplementation(async (provider, refresh) => {
    calls.push([provider, refresh]);
    return apiModelsResponse(['default', ...(refresh ? ['vendor/new-api-model'] : [])]);
  });
  const { result } = await renderProviderState();
  await waitFor(() => assert.equal(result.current.providerModelCatalog.claude?.SOURCE, 'api'));
  await act(async () => { await result.current.providerModelActions.refreshCatalog!('claude'); });
  assert.ok(result.current.providerModelCatalog.claude?.OPTIONS.some((m) => m.value === 'vendor/new-api-model'));
  assert.deepEqual(calls.filter(([, refresh]) => refresh), [['claude', true]]);
  await act(async () => { await result.current.selectProviderModel('claude', 'vendor/new-api-model'); });
  assert.equal(result.current.providerModels.claude, 'vendor/new-api-model');
  assert.equal(localStorage.getItem('claude-model'), 'vendor/new-api-model');
});

test('поздняя начальная загрузка не перезаписывает свежий API-каталог и не теряет другой провайдер', async () => {
  const { api } = await import('@/shared/api');
  let release!: (response: Response) => void;
  const old = new Promise<Response>((resolve) => { release = resolve; });
  vi.spyOn(api.providers, 'models').mockImplementation(async (provider, refresh) => (
    provider === 'claude' && !refresh ? old : apiModelsResponse(['default', `${provider}-fresh`])
  ));
  const { result } = await renderProviderState();
  await act(async () => { await result.current.providerModelActions.refreshCatalog!('claude'); });
  assert.equal(result.current.providerModelCatalog.claude?.OPTIONS[1].value, 'claude-fresh');
  await act(async () => { release(apiModelsResponse(['default', 'obsolete'])); });
  await waitFor(() => assert.equal(result.current.providerModelsLoading, false));
  assert.equal(result.current.providerModelCatalog.claude?.OPTIONS[1].value, 'claude-fresh');
  assert.equal(result.current.providerModelCatalog.codex?.OPTIONS[1].value, 'codex-fresh');
});

for (const customOnlyFlag of [false, true]) {
  test(`холодный сбой API не заменяет сохранённый ID; флаг только своих без записей: ${customOnlyFlag}`, async () => {
    localStorage.setItem('claude-model', 'vendor/remembered-api-model');
    const { api } = await import('@/shared/api');
    vi.spyOn(api.providers, 'models').mockImplementation(async () => new Response(JSON.stringify({ success: true, data: { models: {
      OPTIONS: [{ value: 'default', label: 'Default' }], DEFAULT: 'default', SOURCE: 'fallback', CUSTOM_MODELS_ONLY: customOnlyFlag,
    } } })));
    const { result } = await renderProviderState();
    await waitFor(() => assert.equal(result.current.providerModelCatalog.claude?.SOURCE, 'fallback'));
    assert.equal(result.current.providerModels.claude, 'vendor/remembered-api-model');
    assert.equal(result.current.currentProviderModel, 'vendor/remembered-api-model');
    assert.equal(localStorage.getItem('claude-model'), 'vendor/remembered-api-model');
  });
}

test('сбой ручного обновления сохраняет список и выбранную модель', async () => {
  const { api } = await import('@/shared/api');
  vi.spyOn(api.providers, 'models').mockImplementation(async (_provider, refresh) => {
    if (refresh) throw new Error('fixture refresh failure');
    return apiModelsResponse(['default', 'saved-model']);
  });
  const { result } = await renderProviderState();
  await waitFor(() => assert.equal(result.current.providerModelCatalog.claude?.OPTIONS.length, 2));
  await act(async () => { await result.current.selectProviderModel('claude', 'saved-model'); });
  const before = result.current.providerModelCatalog.claude;
  await act(async () => {
    await assert.rejects(result.current.providerModelActions.refreshCatalog!('claude'), /fixture refresh failure/);
  });
  assert.equal(result.current.providerModelCatalog.claude, before);
  assert.equal(result.current.providerModels.claude, 'saved-model');
});

test('each provider gets its own model from its own storage key', async () => {
  localStorage.setItem('claude-model', 'claude-stored');
  localStorage.setItem('cursor-model', 'cursor-stored');
  localStorage.setItem('codex-model', 'codex-stored');
  localStorage.setItem('opencode-model', 'opencode-stored');

  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.equal(result.current.providerModels.claude, 'claude-stored');
  });
  assert.equal(result.current.providerModels.cursor, 'cursor-stored');
  assert.equal(result.current.providerModels.codex, 'codex-stored');
  assert.equal(result.current.providerModels.opencode, 'opencode-stored');
});

test('a provider with no stored model falls back to its own default, not another provider’s', async () => {
  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.ok(result.current.providerModels.claude);
  });

  const models = result.current.providerModels;
  assert.equal(
    new Set(Object.values(models)).size,
    Object.keys(models).length,
    'each provider must have a distinct default model',
  );
});

test('choosing a model persists it under that provider’s key only', async () => {
  const { result } = await renderProviderState();
  await waitFor(() => {
    assert.ok(result.current.providerModels.codex);
  });
  const claudeBefore = result.current.providerModels.claude;

  act(() => {
    result.current.setStoredProviderModel('codex', 'codex-chosen');
  });

  assert.equal(result.current.providerModels.codex, 'codex-chosen');
  assert.equal(localStorage.getItem('codex-model'), 'codex-chosen');
  assert.equal(
    result.current.providerModels.claude,
    claudeBefore,
    'setting one provider must not disturb another',
  );
  assert.equal(localStorage.getItem('claude-model'), null);
});

test('setting the same model twice keeps the record identity stable', async () => {
  const { result } = await renderProviderState();
  await waitFor(() => {
    assert.ok(result.current.providerModels.claude);
  });

  act(() => {
    result.current.setStoredProviderModel('claude', 'pinned');
  });
  const afterFirst = result.current.providerModels;

  act(() => {
    result.current.setStoredProviderModel('claude', 'pinned');
  });

  assert.equal(
    result.current.providerModels,
    afterFirst,
    'a no-op write must not allocate a new record and wake consumers',
  );
});

test('the active provider’s model is what currentProviderModel reports', async () => {
  // The provider selection is a stored preference; the per-provider model is
  // still a plain localStorage key.
  writeUserPreference('selectedProvider', 'cursor');
  localStorage.setItem('cursor-model', 'cursor-active');

  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.equal(result.current.provider, 'cursor');
  });
  assert.equal(result.current.currentProviderModel, 'cursor-active');
});
