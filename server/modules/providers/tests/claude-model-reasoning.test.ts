import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { queryClaudeSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import type { ProviderRuntimeContext } from '@/shared/types.js';
import { knownGatewayModelReasoning } from '@/modules/providers/list/claude/claude-model-reasoning.js';
import { ClaudeProviderModels, withGatewayEffortSuffix, withoutGatewayEffortSuffix } from '@/modules/providers/list/claude/claude-models.provider.js';

for (const id of ['gemini-4-argon-high', 'gemini-3.8-flash-high', 'claude-opus-5-5-high', 'claude-sonnet-5-5-high']) {
  test(`${id}: три подтверждённых уровня, suffix действительно меняет запрос`, async () => {
    const provider = new ClaudeProviderModels({ get: async () => ({ source: 'api', models: [{ id, label: id, catalogProvider: 'antigravity' }] }) });
    const models = await provider.getSupportedModels();
    const option = models.OPTIONS.find(m => m.value === id)!;
    assert.deepEqual(option.effort?.values.map(v => v.value), ['low', 'medium', 'high']);
    assert.equal(option.effort?.transport, 'model-suffix');
    assert.equal(option.effort?.default, undefined, 'не выдаём шаблонный client default за реальный');
    assert.equal(withGatewayEffortSuffix(id, 'low', models), `${id}(low)`);
    assert.equal(withoutGatewayEffortSuffix(`${id}(low)`), id);
  });
}

for (const model of ['gemini-4-argon-high', 'claude-sonnet-5-5-high', 'vendor/future']) {
  for (const effort of model === 'vendor/future' ? ['minimal'] : ['low', 'high', 'default']) {
    test(`SDK получает ${model} с выбранным ${effort}, а не только надпись в UI`, async () => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), 'reasoning-sdk-'));
      let captured: Record<string, unknown> | undefined;
      const provider = new ClaudeProviderModels({ get: async () => ({ source: 'api', models: [{ id: model, label: model, catalogProvider: 'antigravity',
        ...(model === 'vendor/future' ? { effort: { transport: 'model-suffix' as const, values: [{ value: 'minimal' }] } } : {}),
      }] }) });
      const catalog = await provider.getSupportedModels();
      const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
      const context: ProviderRuntimeContext = {
        resolveProviderSessionId: () => null,
        resolveResumeModel: async () => undefined,
        getProviderModels: async () => catalog,
        normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
        isProviderInstalled: async () => true,
        createQuery: ({ options, prompt }) => {
          captured = options as Record<string, unknown>;
          void (async () => { for await (const _message of prompt) { /* чтение stdin */ } })();
          const stream = (async function* () {
            yield { type: 'result', subtype: 'success', session_id: 'reasoning-native', result: 'ok', duration_ms: 1, num_turns: 1 };
          })();
          return Object.assign(stream, { interrupt: async () => {} }) as never;
        },
      };
      try {
        await queryClaudeSDK('test reasoning', { sessionId: 'reasoning-app', cwd, model, effort }, { send() {}, userId: null } as never, context);
        assert.equal(captured?.model, effort === 'default' ? model : `${model}(${effort})`);
        assert.equal(captured?.effort, effort === 'default' || effort === 'minimal' ? undefined : effort,
          'расширенный уровень шлюза не попадает в валидатор CLI; стандартный контракт SDK сохранён');
      } finally { await rm(cwd, { recursive: true, force: true }); }
    });
  }
}

test('новые GPT текущего шлюза получают подтверждённые пять уровней, не шаблонный ultra', async () => {
  for (const id of ['gpt-6-sol', 'gpt-6-chat-thinking', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra']) {
    assert.deepEqual(knownGatewayModelReasoning(id)?.effort?.values.map(v => v.value), ['low', 'medium', 'high', 'xhigh', 'max']);
  }
});

test('неизвестная модель не наследует уровни соседей, картинки не получают reasoning', async () => {
  const provider = new ClaudeProviderModels({ get: async () => ({ source: 'api', models: [
    { id: 'gemini-future', label: 'Gemini Future', catalogProvider: 'antigravity' },
    { id: 'gpt-image-2.6', label: 'Images', catalogProvider: 'openai' },
  ] }) });
  const models = await provider.getSupportedModels();
  assert.equal(models.OPTIONS[1].reasoningStatus, 'unknown');
  assert.equal(models.OPTIONS[1].effort, undefined);
  assert.equal(models.OPTIONS[2].reasoningStatus, 'unsupported');
  assert.equal(models.OPTIONS[2].effort, undefined);
});

test('явные capabilities API для будущей модели имеют приоритет над резервными метаданными', async () => {
  const provider = new ClaudeProviderModels({ get: async () => ({ source: 'api', models: [{
    id: 'vendor/new-model', label: 'Future model', effort: { transport: 'model-suffix', values: [{ value: 'minimal' }, { value: 'high' }] },
  }] }) });
  const models = await provider.getSupportedModels();
  assert.equal(models.OPTIONS[1].effort?.values[0].value, 'minimal');
  assert.equal(withGatewayEffortSuffix('vendor/new-model', 'minimal', models), 'vendor/new-model(minimal)');
  assert.equal(withGatewayEffortSuffix('vendor/new-model', 'ultra', models), 'vendor/new-model', 'недопустимый уровень не отправляется');
});

test('явное отсутствие reasoning в API не заменяется известными уровнями', async () => {
  const provider = new ClaudeProviderModels({ get: async () => ({ source: 'api', models: [{
    id: 'gpt-6.1-sol', label: 'GPT', reasoningStatus: 'unsupported',
  }] }) });
  const models = await provider.getSupportedModels();
  assert.equal(models.OPTIONS[1].effort, undefined);
  assert.equal(models.OPTIONS[1].reasoningStatus, 'unsupported');
});
