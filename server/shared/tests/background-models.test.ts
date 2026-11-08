import assert from 'node:assert/strict';
import test from 'node:test';

import { backgroundThinkingRetry, buildBackgroundModelRequest, isBackgroundTextModel } from '@/shared/background-models.js';
import type { ApiModel, SmallModelRequest } from '@/shared/small-model.js';

// GOLDJAXE fork (реестр §4.16-тер): одна проверенная политика для titles и summary.
const entry = (id: string, extra: Partial<ApiModel> = {}): ApiModel => ({ id, label: id, ...extra });

test('effort применяется только к модели текущего каталога, не ко всему известному списку', () => {
  assert.deepEqual(buildBackgroundModelRequest('gpt-6.1-sol'), { model: 'gpt-6.1-sol' });
  assert.deepEqual(buildBackgroundModelRequest('gpt-6.1-sol', [entry('other')]), { model: 'gpt-6.1-sol' });
  for (const id of ['gpt-unknown', 'gemini-text-unknown', 'new-provider-text', 'claude-haiku-4-5-20251001', 'kimi-k3[1m]']) {
    assert.deepEqual(buildBackgroundModelRequest(id, [entry(id)]), { model: id });
  }
});

test('подтверждённые GPT и маски получают минимальный suffix, Claude — sdk effort', () => {
  for (const id of ['gpt-6.1-sol', `claude-fable-5-dd-${[...'gpt-6.1-sol'].reverse().join('')}`]) {
    assert.deepEqual(buildBackgroundModelRequest(id, [entry(id)]), { model: `${id}(low)` });
  }
  const id = 'claude-sonnet-5-5';
  assert.deepEqual(buildBackgroundModelRequest(id, [entry(id)]), { model: id, effort: 'low', adaptiveThinking: true });
  const antigravity = 'claude-opus-5-5-high';
  assert.deepEqual(buildBackgroundModelRequest(antigravity, [entry(antigravity, { catalogProvider: 'antigravity' })]), {
    model: `${antigravity}(low)`,
  });
});

test('реальные capabilities важнее известных/synthetic уровней и транспортов', () => {
  const id = 'gpt-6.1-sol';
  assert.deepEqual(buildBackgroundModelRequest(id, [entry(id, { effort: {
    transport: 'sdk', values: [{ value: 'max' }],
  } })]), { model: id, effort: 'max' });
  for (const reasoningStatus of ['unknown', 'unsupported'] as const) {
    assert.deepEqual(buildBackgroundModelRequest(id, [entry(id, { reasoningStatus })]), { model: id });
  }
  for (const effort of ['none', 'minimal', 'ultra']) {
    const custom = entry('new-text-model', { effort: { transport: 'model-suffix', values: [{ value: effort }] } });
    assert.deepEqual(buildBackgroundModelRequest(custom.id, [custom]), { model: `${custom.id}(${effort})` });
  }
  const unknown = entry('gpt-future', { effort: { values: [{ value: 'low' }] } });
  assert.deepEqual(buildBackgroundModelRequest(unknown.id, [unknown]), { model: unknown.id });
  const noSuffixChange = entry('custom-text(low)', { effort: { transport: 'model-suffix', values: [{ value: 'low' }] } });
  assert.deepEqual(buildBackgroundModelRequest(noSuffixChange.id, [noSuffixChange]), { model: noSuffixChange.id });
});

test('минимальный уровень берётся только из реальных значений, ultracode исключён', () => {
  const custom = entry('text-model', { effort: {
    transport: 'sdk', values: [{ value: 'ultracode' }, { value: 'medium' }, { value: 'high' }],
  } });
  assert.deepEqual(buildBackgroundModelRequest(custom.id, [custom]), { model: custom.id, effort: 'medium' });
  const unordered = entry('other-text', { effort: {
    transport: 'model-suffix', values: [{ value: 'high' }, { value: 'minimal' }, { value: 'low' }],
  } });
  assert.deepEqual(buildBackgroundModelRequest(unordered.id, [unordered]), { model: 'other-text(minimal)' });
});

test('thinking retry не угадывается по неизвестной non-Claude модели и не включается для масок GPT', () => {
  const request = (model: string): SmallModelRequest => ({ model, system: '', messages: [], maxTokens: 3000 });
  for (const id of ['gpt-6.1-sol', 'unknown', `claude-fable-5-dd-${[...'gpt-6.1-sol'].reverse().join('')}`]) {
    assert.equal(backgroundThinkingRetry(request(id)), null);
  }
  assert.equal(backgroundThinkingRetry(request('claude-haiku-4-5-20251001'))?.thinkingBudget, 1024);
  assert.equal(backgroundThinkingRetry(request('claude-sonnet-5-5'))?.adaptiveThinking, true);
  assert.equal(backgroundThinkingRetry({ ...request('claude-sonnet-5-5'), adaptiveThinking: true }), null);
});

test('фильтр допускает все текстовые семейства и контекстные aliases, но не генераторы изображений', () => {
  for (const id of ['gpt-6.1-sol', 'claude-opus-5-5[1m]', 'gemini-text', 'deepseek-text', 'new-model', 'gpt-audio-chat', 'voice-assistant-text']) {
    assert.equal(isBackgroundTextModel(entry(id)), true, id);
  }
  for (const id of ['gpt-image-2', 'nano-banana-pro', 'imagen-4', 'dall-e-3', 'flux-2',
    'whisper-1', 'openai/whisper-large-v3', 'tts-1', 'gpt-4o-mini-tts', 'gpt-4o-transcribe', 'text-embedding-3-small', 'embed-english-v3']) {
    assert.equal(isBackgroundTextModel(entry(id)), false, id);
    const masked = `claude-fable-5-dd-${[...id].reverse().join('')}`;
    assert.equal(isBackgroundTextModel(entry(masked)), false, masked);
  }
  assert.equal(isBackgroundTextModel(entry('opaque', { label: 'Image generator' })), false);
});
