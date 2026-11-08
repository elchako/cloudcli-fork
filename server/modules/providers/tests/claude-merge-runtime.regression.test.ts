import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  IMAGE_GENERATION_MCP_SERVER_NAME,
  IMAGE_GENERATION_TOOL_ID,
} from '@/modules/image-generation/index.js';
import { CLAUDE_PREDEFINED_MODELS, ClaudeProviderModels } from '@/modules/providers/list/claude/claude-models.provider.js';
import {
  queryClaudeSDK,
  steerClaudeSDKSession,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { AnyRecord, ProviderRuntimeContext } from '@/shared/types.js';

// GOLDJAXE fork (реестр §1.3, §1.1, §2.2): новые возможности upstream не должны
// вытеснять настройки шлюза, встроенный MCP и границу доверия вложений.
async function withEnv(values: NodeJS.ProcessEnv, run: () => Promise<void>): Promise<void> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function runScripted(options: AnyRecord, steerOptions?: AnyRecord, modelsDefinition = CLAUDE_PREDEFINED_MODELS) {
  const sent: unknown[] = [];
  const stdin: AnyRecord[] = [];
  let sdkOptions: AnyRecord = {};
  let steered = false;
  const sessionId = 'app-merge-runtime';
  const nativeId = 'native-merge-runtime';
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => nativeId,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => modelsDefinition as never,
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
    createQuery: ({ prompt, options: resolvedOptions }) => {
      sdkOptions = resolvedOptions;
      const stream = (async function* () {
        const input = prompt[Symbol.asyncIterator]();
        stdin.push((await input.next()).value as AnyRecord);
        if (steerOptions) {
          steered = await steerClaudeSDKSession(sessionId, 'уточнение', steerOptions);
          if (steered) {
            const message = (await input.next()).value as AnyRecord;
            stdin.push(message);
            yield { ...message, isReplay: true, session_id: nativeId };
          }
        }
        yield { type: 'result', subtype: 'success', session_id: nativeId, result: 'готово' };
      })();
      // Нативный interrupt возвращает ответ, а не void; runtime не читает его.
      return Object.assign(stream, { interrupt: async () => ({}) });
    },
  };

  await queryClaudeSDK('основной запрос', { ...options, sessionId }, {
    userId: null,
    send: (message) => { sent.push(message); },
  }, context);
  const kinds = sent.map((message) => (
    message && typeof message === 'object' && 'kind' in message ? message.kind : undefined
  ));
  assert.equal(kinds.includes('error'), false);
  assert.equal(kinds.filter((kind) => kind === 'complete').length, 1);
  return { sdkOptions, stdin, steered };
}

test('каталог API сохраняет effort и 930k для нового маскированного и старого прямого ID GPT', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-api-runtime-'));
  const wrapped = `claude-fable-5-dd-${[...'gpt-6.1-sol'].reverse().join('')}`;
  try {
    const definition = await new ClaudeProviderModels({ get: async () => ({ models: [{ id: wrapped, label: 'API Sol' }], source: 'api' }) }).getSupportedModels();
    await withEnv({ CLOUDCLI_IMAGE_GEN: 'off', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '930000' }, async () => {
      for (const model of [wrapped, 'gpt-6.1-sol']) {
        for (const catalog of [definition, CLAUDE_PREDEFINED_MODELS]) {
          const { sdkOptions } = await runScripted({ cwd, model, effort: 'max' }, undefined, catalog);
          assert.equal(sdkOptions.model, `${model}(max)`);
          assert.equal(sdkOptions.effort, 'max');
          assert.equal(sdkOptions.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '930000');
        }
      }
    });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('image MCP, GPT effort и вложения работают вместе с upstream steering', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-merge-runtime-'));
  const cwd = path.join(root, 'project');
  try {
    await mkdir(cwd);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jDPkAAAAASUVORK5CYII=', 'base64');
    const imagePath = path.join(cwd, 'photo.png');
    const outsidePath = path.join(root, 'private.png');
    const symlinkPath = path.join(cwd, 'private-link.png');
    const documentPath = path.join(cwd, 'notes.txt');
    await writeFile(imagePath, png);
    await writeFile(outsidePath, 'данные вне cwd');
    await symlink(outsidePath, symlinkPath);
    await writeFile(documentPath, 'вложенный документ');
    const images = [imagePath, outsidePath, symlinkPath].map((filePath) => ({ path: filePath }));
    const files = [{ path: documentPath, name: 'заметки.txt' }];

    await withEnv({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
      ANTHROPIC_API_KEY: 'regression-fixture-only',
      ANTHROPIC_AUTH_TOKEN: undefined,
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '930000',
      CLOUDCLI_IMAGE_GEN: 'on',
    }, async () => {
      const { sdkOptions, stdin, steered } = await runScripted({
        cwd, model: 'gpt-6.1-sol', effort: 'max', images, files,
        toolsSettings: { allowedTools: [], disallowedTools: [IMAGE_GENERATION_TOOL_ID], skipPermissions: false },
      }, { images, files, messageId: 'merge-steer-message' });

      assert.equal(sdkOptions.model, 'gpt-6.1-sol(max)');
      assert.equal(sdkOptions.effort, 'max');
      assert.equal(sdkOptions.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '930000');
      assert.ok(sdkOptions.mcpServers[IMAGE_GENERATION_MCP_SERVER_NAME]);
      assert.ok(sdkOptions.allowedTools.includes(IMAGE_GENERATION_TOOL_ID));
      assert.equal((await sdkOptions.canUseTool(IMAGE_GENERATION_TOOL_ID, {})).behavior, 'deny');
      assert.deepEqual(sdkOptions.extraArgs, { 'replay-user-messages': null });
      assert.equal(typeof sdkOptions.onElicitation, 'function');
      assert.equal(steered, true);
      assert.equal(stdin.length, 2);
      assert.equal(stdin[1].priority, 'next');
      assert.equal(stdin[1].uuid, 'merge-steer-message');
      for (const message of stdin) {
        const blocks = message.message.content as AnyRecord[];
        assert.deepEqual(blocks.filter((block) => block.type === 'image').map((block) => block.source.data), [png.toString('base64')]);
        const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
        assert.ok(text.includes('<files_input>'));
        assert.ok(text.includes(documentPath));
        assert.ok(text.includes('заметки.txt'));
        assert.ok(!text.includes(outsidePath));
        assert.ok(!text.includes(symlinkPath));
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Kimi сохраняет endpoint по умолчанию и уважает явный endpoint', async () => {
  await withEnv({
    ANTHROPIC_AUTH_TOKEN: 'regression-fixture-only',
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_BASE_URL: undefined,
    CLOUDCLI_IMAGE_GEN: 'off',
  }, async () => {
    const kimi = await runScripted({ model: 'kimi-k3[1m]' });
    assert.equal(kimi.sdkOptions.model, 'kimi-k3[1m]');
    assert.equal(kimi.sdkOptions.env.ANTHROPIC_BASE_URL, 'https://api.moonshot.ai/anthropic');
    const claude = await runScripted({ model: CLAUDE_PREDEFINED_MODELS.DEFAULT });
    assert.equal(claude.sdkOptions.env.ANTHROPIC_BASE_URL, undefined);
    await withEnv({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/custom' }, async () => {
      const explicit = await runScripted({ model: 'kimi-k3[1m]' });
      assert.equal(explicit.sdkOptions.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9/custom');
    });
  });
});
