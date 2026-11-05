import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';

import {
  isAdaptiveThinkingModel,
  listSmallModels,
  postSmallModelRequest,
  type SmallModelCredentials,
  type SmallModelRequest,
} from '../small-model.js';

// GOLDJAXE fork (реестр §4.16-бис): what the small-model transport actually
// puts on the wire, against a local stand-in for the gateway.

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> | null };

let server: http.Server;
let base = '';
const seen: Seen[] = [];
let reply: (request: Seen, response: http.ServerResponse) => void = () => {};

before(async () => {
  server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      const entry: Seen = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: raw ? JSON.parse(raw) as Record<string, unknown> : null,
      };
      seen.push(entry);
      reply(entry, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const credentials = (isApiKey = false): SmallModelCredentials => ({ token: 'test-token', baseUrl: base, isApiKey });

function json(response: http.ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

const REQUEST: SmallModelRequest = {
  model: 'claude-haiku-5-5',
  system: 'system',
  messages: [{ role: 'user', content: 'текст' }],
  maxTokens: 3000,
};

describe('postSmallModelRequest', () => {
  it('sends effort without a temperature, and keeps only the text blocks', async () => {
    seen.length = 0;
    reply = (_request, response) => json(response, 200, {
      content: [{ type: 'thinking', thinking: 'скрыто' }, { type: 'text', text: 'Готово.' }],
      stop_reason: 'end_turn',
    });
    const outcome = await postSmallModelRequest(credentials(), { ...REQUEST, effort: 'low' }, { timeoutMs: 5000 });
    assert.deepEqual(outcome, { status: 'ok', text: 'Готово.', stopReason: 'end_turn' });
    const { body, headers, url } = seen[0];
    assert.equal(url, '/v1/messages');
    assert.equal(headers.authorization, 'Bearer test-token');
    assert.equal(body?.max_tokens, 3000);
    assert.deepEqual(body?.output_config, { effort: 'low' });
    assert.equal('temperature' in (body ?? {}), false);
    assert.equal('thinking' in (body ?? {}), false);
  });

  it('turns on adaptive thinking within the answer limit', async () => {
    seen.length = 0;
    reply = (_request, response) => json(response, 200, { content: [{ type: 'text', text: 'Ок.' }], stop_reason: 'end_turn' });
    await postSmallModelRequest(credentials(true), { ...REQUEST, effort: 'low', adaptiveThinking: true }, { timeoutMs: 5000 });
    const { body, headers } = seen[0];
    assert.equal(headers['x-api-key'], 'test-token');
    assert.deepEqual(body?.thinking, { type: 'adaptive' });
    assert.equal(body?.max_tokens, 3000);
    assert.deepEqual(body?.output_config, { effort: 'low' });
  });

  it('adds a thinking budget on top of the answer for older models', async () => {
    seen.length = 0;
    reply = (_request, response) => json(response, 200, { content: [{ type: 'text', text: 'Ок.' }], stop_reason: 'end_turn' });
    await postSmallModelRequest(
      credentials(),
      { ...REQUEST, model: 'claude-haiku-4-5-20251001', temperature: 0.2, thinkingBudget: 1024 },
      { timeoutMs: 5000 },
    );
    const { body } = seen[0];
    assert.equal(body?.max_tokens, 4024);
    assert.deepEqual(body?.thinking, { type: 'enabled', budget_tokens: 1024 });
    // The API rejects a non-default temperature once thinking is on.
    assert.equal('temperature' in (body ?? {}), false);
    assert.equal('output_config' in (body ?? {}), false);
  });

  it('keeps the temperature of a plain request (session titles)', async () => {
    seen.length = 0;
    reply = (_request, response) => json(response, 200, { content: [{ type: 'text', text: 'Название' }], stop_reason: 'end_turn' });
    await postSmallModelRequest(credentials(), { ...REQUEST, model: 'claude-haiku-4-5-20251001', temperature: 0 }, { timeoutMs: 5000 });
    assert.equal(seen[0].body?.temperature, 0);
    assert.equal('output_config' in (seen[0].body ?? {}), false);
  });

  it('reports the gateway thinking demand, other errors and a timeout without text', async () => {
    reply = (_request, response) => json(response, 400, { error: { message: 'thinking is required for this model' } });
    assert.deepEqual(await postSmallModelRequest(credentials(), REQUEST, { timeoutMs: 5000 }), { status: 'needs-thinking' });
    // With thinking already on, the same answer is a plain failure: no retry loop.
    assert.deepEqual(
      await postSmallModelRequest(credentials(), { ...REQUEST, adaptiveThinking: true }, { timeoutMs: 5000 }),
      { status: 'failed', reason: 'HTTP 400' },
    );
    reply = (_request, response) => json(response, 502, { error: 'секрет в теле' });
    assert.deepEqual(await postSmallModelRequest(credentials(), REQUEST, { timeoutMs: 5000 }), { status: 'failed', reason: 'HTTP 502' });
    reply = () => {};
    assert.deepEqual(await postSmallModelRequest(credentials(), REQUEST, { timeoutMs: 100 }), { status: 'failed', reason: 'timeout' });
  });
});

describe('listSmallModels', () => {
  it('asks /v1/models with the same credentials and returns the ids', async () => {
    seen.length = 0;
    reply = (_request, response) => json(response, 200, { data: [{ id: 'claude-haiku-5-5' }, { id: 7 }, null, { id: 'claude-sonnet-5-5' }] });
    assert.deepEqual(await listSmallModels(credentials(), { timeoutMs: 5000 }), ['claude-haiku-5-5', 'claude-sonnet-5-5']);
    assert.equal(seen[0].method, 'GET');
    assert.equal(seen[0].url, '/v1/models?limit=1000');
    assert.equal(seen[0].headers.authorization, 'Bearer test-token');
    assert.equal(seen[0].headers['anthropic-version'], '2023-06-01');
  });

  it('returns null on an error, a malformed answer or a timeout', async () => {
    reply = (_request, response) => json(response, 401, { error: 'unauthorized' });
    assert.equal(await listSmallModels(credentials(), { timeoutMs: 5000 }), null);
    reply = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('не json');
    };
    assert.equal(await listSmallModels(credentials(), { timeoutMs: 5000 }), null);
    reply = (_request, response) => json(response, 200, { data: 'не массив' });
    assert.equal(await listSmallModels(credentials(), { timeoutMs: 5000 }), null);
    reply = () => {};
    assert.equal(await listSmallModels(credentials(), { timeoutMs: 100 }), null);
  });
});

describe('isAdaptiveThinkingModel', () => {
  it('knows the adaptive models, also behind a gateway or cloud prefix', () => {
    for (const model of [
      'claude-haiku-5-5', 'claude-sonnet-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-6', 'claude-fable-5-1',
      'anthropic/claude-opus-5-5@2026[1m]', 'us.anthropic.claude-sonnet-5-5', 'claude-sonnet-4-7-20260101',
    ]) {
      assert.equal(isAdaptiveThinkingModel(model), true, model);
    }
    for (const model of [
      'claude-haiku-4-5-20251001', 'claude-opus-4-5', 'claude-sonnet-4-20250514', 'claude-3-5-haiku-latest',
      'claude-fable-5-dd-high', 'gpt-5', 'my-claude-opus-5', '',
    ]) {
      assert.equal(isAdaptiveThinkingModel(model), false, model);
    }
  });
});
