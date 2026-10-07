import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractClaudeEventModel,
  findClaudeModelOption,
  withGatewayEffortSuffix,
} from '@/modules/providers/list/claude/claude-models.provider.js';

const SESSION_ID = 'session-1';

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
