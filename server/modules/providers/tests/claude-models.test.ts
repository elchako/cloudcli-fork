import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLAUDE_PREDEFINED_MODELS,
  CLAUDE_ULTRACODE_EFFORT,
  ClaudeProviderModels,
  extractClaudeEventModel,
  findClaudeModelOption,
  withGatewayEffortSuffix,
} from '@/modules/providers/list/claude/claude-models.provider.js';

const SESSION_ID = 'session-1';

// Pinned versions as Claude Code's own model picker declares them: id, effort default,
// whether xhigh is offered. `null` marks a model with no effort control.
const PINNED_MODELS: ReadonlyArray<[id: string, defaultEffort: string | null, xhigh: boolean]> = [
  ['claude-fable-5-2', 'medium', true],
  ['claude-fable-5-1', 'high', true],
  ['claude-fable-5', 'high', true],
  ['claude-opus-5-5', 'medium', true],
  ['claude-opus-5', 'high', true],
  ['claude-opus-4-8', 'high', true],
  ['claude-opus-4-7', 'xhigh', true],
  ['claude-opus-4-6', 'high', false],
  ['claude-sonnet-5-5', 'medium', true],
  ['claude-sonnet-5', 'high', true],
  ['claude-sonnet-4-6', 'high', false],
  ['claude-haiku-5-5', 'medium', true],
  ['claude-haiku-4-5-20251001', null, false],
];

test('offers each pinned version with the effort levels and default Claude Code uses for it', () => {
  for (const [id, defaultEffort, xhigh] of PINNED_MODELS) {
    const option = findClaudeModelOption(id);
    assert.ok(option, `${id} is missing from the catalog`);

    if (defaultEffort === null) {
      assert.equal(option.effort, undefined, `${id} should have no effort control`);
      continue;
    }

    const levels = option.effort?.values.map((level) => level.value) ?? [];
    assert.equal(option.effort?.default, defaultEffort, `${id} default effort`);
    assert.ok(levels.includes(defaultEffort), `${id} default must be one of its levels`);
    assert.equal(levels.includes('xhigh'), xhigh, `${id} xhigh`);
  }
});

test('offers ultracode only on xhigh-capable pinned versions outside the Haiku family', () => {
  for (const [id, , xhigh] of PINNED_MODELS) {
    const levels = findClaudeModelOption(id)?.effort?.values.map((level) => level.value) ?? [];
    const expected = xhigh && !id.startsWith('claude-haiku-');
    assert.equal(levels.includes(CLAUDE_ULTRACODE_EFFORT), expected, `${id} ultracode`);
  }
});

test('сохраняет прежние ID форка, добавляет pinned-версии без дублей и не меняет default', () => {
  const values = CLAUDE_PREDEFINED_MODELS.OPTIONS.map((option) => option.value);

  assert.equal(CLAUDE_PREDEFINED_MODELS.DEFAULT, 'default');
  assert.deepEqual(values.slice(0, 9), [
    'kimi-k3[1m]', 'gpt-6-astra', 'gpt-6.1-sol', 'default', 'best',
    'claude-fable-5-1[1m]', 'claude-sonnet-5-5[1m]', 'claude-opus-5-5[1m]', 'opusplan',
  ]);
  assert.deepEqual(values.slice(9), PINNED_MODELS.map(([id]) => id));
  assert.equal(new Set(values).size, values.length);
});

test('offers pinned Haiku the effort levels Claude Code accepts for it, starting at its own default', () => {
  const haikuEffort = findClaudeModelOption('claude-haiku-5-5')?.effort;
  const levels = haikuEffort?.values.map((level) => level.value);

  assert.deepEqual(levels, ['low', 'medium', 'high', 'xhigh', 'max']);
  // The level Claude Code runs Haiku at when none is sent, so adding the control changes nothing by itself.
  assert.equal(haikuEffort?.default, 'medium');
  assert.equal(levels?.includes(CLAUDE_ULTRACODE_EFFORT), false);
});

test('pinned-версии не подмешиваются в динамический каталог и не меняют ID API', async () => {
  const provider = new ClaudeProviderModels({ get: async () => ({ source: 'api', models: [
    { id: 'vendor/future', label: 'Future API' },
    { id: 'claude-fable-5-2', label: 'claude-fable-5-2' },
  ] }) });
  const models = await provider.getSupportedModels();

  assert.deepEqual(models.OPTIONS.map(option => option.value), ['default', 'vendor/future', 'claude-fable-5-2']);
  assert.equal(models.SOURCE, 'api');
  assert.equal(models.DEFAULT, 'default');
  assert.equal(models.OPTIONS[1].effort, undefined);
  assert.equal(models.OPTIONS[2].label, 'Fable 5.2');
  assert.deepEqual(models.OPTIONS[2].effort, findClaudeModelOption('claude-fable-5-2')?.effort);
  assert.equal(withGatewayEffortSuffix('claude-fable-5-2', 'medium', models), 'claude-fable-5-2');
});

test('новые pinned-метаданные не перекрывают Antigravity и явные capabilities API', async () => {
  const provider = new ClaudeProviderModels({ get: async () => ({ source: 'api', models: [
    { id: 'claude-opus-5-5-high', label: 'Opus API', catalogProvider: 'antigravity' },
    { id: 'claude-fable-5-2', label: 'Fable API', effort: {
      transport: 'sdk', default: 'low', values: [{ value: 'low' }, { value: 'high' }],
    } },
    { id: 'claude-sonnet-5-5', label: 'Sonnet API', reasoningStatus: 'unsupported' },
  ] }) });
  const models = await provider.getSupportedModels();

  const antigravity = models.OPTIONS[1];
  assert.equal(antigravity.catalogProvider, 'antigravity');
  assert.deepEqual(antigravity.effort?.values.map(option => option.value), ['low', 'medium', 'high']);
  assert.equal(antigravity.effort?.transport, 'model-suffix');
  assert.equal(antigravity.effort?.default, undefined);
  assert.equal(withGatewayEffortSuffix(antigravity.value, 'low', models), 'claude-opus-5-5-high(low)');
  assert.deepEqual(models.OPTIONS[2].effort, {
    transport: 'sdk', default: 'low', values: [{ value: 'low' }, { value: 'high' }],
  });
  assert.equal(models.OPTIONS[3].effort, undefined);
  assert.equal(models.OPTIONS[3].reasoningStatus, 'unsupported');
});

test('ignores the <synthetic> placeholder Claude Code stamps on synthesized rows', () => {
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { model: '<synthetic>' } },
      SESSION_ID,
    ),
    null,
  );
  assert.equal(
    extractClaudeEventModel({ sessionId: SESSION_ID, model: '<synthetic>' }, SESSION_ID),
    null,
  );
});

test('still surfaces real model ids from message and event fields', () => {
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { model: 'claude-sonnet-5' } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
  assert.equal(
    extractClaudeEventModel({ sessionId: SESSION_ID, model: 'opus' }, SESSION_ID),
    'opus',
  );
});

test('skips a placeholder content part so a later real model tag still wins', () => {
  assert.equal(
    extractClaudeEventModel(
      {
        sessionId: SESSION_ID,
        message: {
          content: [
            { text: '<model><synthetic></model>' },
            { text: '<model>claude-sonnet-5</model>' },
          ],
        },
      },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

test('a placeholder stdout hit does not shadow a real <model> tag in the same text', () => {
  const text = '<local-command-stdout>Set model to <synthetic></local-command-stdout>'
    + '<model>claude-sonnet-5</model>';
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { content: text } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { content: [{ text }] } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

test('falls back to the message model when every content hit is a placeholder', () => {
  assert.equal(
    extractClaudeEventModel(
      {
        sessionId: SESSION_ID,
        message: {
          content: '<model><synthetic></model>',
          model: 'claude-sonnet-5',
        },
      },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

test('catalog offers the gateway GPT models with the levels CLIProxyAPI accepts', () => {
  for (const model of ['gpt-6-astra', 'gpt-6.1-sol']) {
    const option = findClaudeModelOption(model);
    assert.ok(option, `${model} is in the catalog`);
    assert.deepEqual(
      option.effort?.values.map((entry) => entry.value),
      ['low', 'medium', 'high', 'xhigh', 'max'],
    );
  }
});

test('gateway GPT models carry the chosen reasoning level in the model id', () => {
  assert.equal(withGatewayEffortSuffix('gpt-6-astra', 'max'), 'gpt-6-astra(max)');
  assert.equal(withGatewayEffortSuffix('gpt-6.1-sol', 'low'), 'gpt-6.1-sol(low)');
});

test('the effort suffix leaves other models and level-less GPT runs untouched', () => {
  assert.equal(withGatewayEffortSuffix('claude-opus-5-5[1m]', 'max'), 'claude-opus-5-5[1m]');
  assert.equal(withGatewayEffortSuffix('kimi-k3[1m]', 'high'), 'kimi-k3[1m]');
  assert.equal(withGatewayEffortSuffix('gpt-6-astra', undefined), 'gpt-6-astra');
  // An id that already names its level is never suffixed twice.
  assert.equal(withGatewayEffortSuffix('gpt-6-astra(high)', 'max'), 'gpt-6-astra(high)');
});
