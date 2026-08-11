import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { buildFallbackTitle, generateSessionTitle } from '@/modules/providers/services/session-title.service.js';

const LONG_PROMPT =
  'продолжаем дорабатывать боковую панель CloudCLI: выделение активного сеанса и короткие названия';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

/** Replaces fetch with a stub and records the requests it received. */
function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const calls: { url: string; init: RequestInit }[] = [];

  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof globalThis.fetch;

  return calls;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textBlockResponse(text: string): Response {
  return jsonResponse({ content: [{ type: 'text', text }] });
}

describe('session title service', () => {
  beforeEach(() => {
    // The service reads credentials from the environment, so every test starts
    // from a known state instead of inheriting the developer's own gateway.
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.CLOUDCLI_SESSION_TITLES;
    delete process.env.CLOUDCLI_SESSION_TITLE_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it('shortens a long prompt on a word boundary', () => {
    const fallback = buildFallbackTitle(LONG_PROMPT);

    assert.ok(fallback.length <= 49, `fallback too long: ${fallback.length}`);
    assert.ok(fallback.endsWith('…'));
    assert.ok(!fallback.includes('  '));
  });

  it('keeps a short prompt as-is and never calls the model', async () => {
    const calls = stubFetch(() => textBlockResponse('не должно вызываться'));
    process.env.ANTHROPIC_API_KEY = 'test-key';

    const result = await generateSessionTitle('GPU scribe');

    assert.equal(result?.title, 'GPU scribe');
    assert.equal(result?.fullTitle, null);
    assert.equal(result?.generated, false);
    assert.equal(calls.length, 0);
  });

  it('returns the model title and keeps the original prompt for the tooltip', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const calls = stubFetch(() => textBlockResponse('CloudCLI — боковая панель сеансов'));

    const result = await generateSessionTitle(LONG_PROMPT);

    assert.equal(result?.title, 'CloudCLI — боковая панель сеансов');
    assert.equal(result?.fullTitle, LONG_PROMPT);
    assert.equal(result?.generated, true);
    assert.equal(calls.length, 1);
    const apiKeyHeaders = calls[0]?.init.headers as Record<string, string>;
    assert.equal(apiKeyHeaders['x-api-key'], 'test-key');
  });

  it('sends an auth token as a bearer when no api key is configured', async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'gateway-token';
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.example/';
    const calls = stubFetch(() => textBlockResponse('Проект — задача'));

    await generateSessionTitle(LONG_PROMPT);

    assert.equal(calls[0]?.url, 'https://gateway.example/v1/messages');
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers.authorization, 'Bearer gateway-token');
    assert.equal(headers['x-api-key'], undefined);
  });

  it('strips quotes, prefixes and trailing punctuation from the model answer', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    stubFetch(() => textBlockResponse('  "Заголовок: CloudCLI — панель сеансов."  '));

    const result = await generateSessionTitle(LONG_PROMPT);

    assert.equal(result?.title, 'CloudCLI — панель сеансов');
  });

  it('falls back to the trimmed prompt when the gateway fails', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    stubFetch(() => jsonResponse({ error: 'boom' }, 500));

    const result = await generateSessionTitle(LONG_PROMPT);

    assert.equal(result?.title, buildFallbackTitle(LONG_PROMPT));
    assert.equal(result?.generated, false);
    assert.equal(result?.fullTitle, LONG_PROMPT);
  });

  it('falls back when the request throws', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    stubFetch(() => {
      throw new Error('network down');
    });

    const result = await generateSessionTitle(LONG_PROMPT);

    assert.equal(result?.title, buildFallbackTitle(LONG_PROMPT));
    assert.equal(result?.generated, false);
  });

  it('falls back when the model answers with an explanation instead of a title', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    stubFetch(() =>
      textBlockResponse(
        'Извините, я не могу выполнить эту задачу, потому что запрос выглядит неоднозначным и требует уточнения от пользователя.',
      ),
    );

    const result = await generateSessionTitle(LONG_PROMPT);

    assert.equal(result?.title, buildFallbackTitle(LONG_PROMPT));
    assert.equal(result?.generated, false);
  });

  it('skips the model entirely when titling is switched off', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.CLOUDCLI_SESSION_TITLES = 'off';
    const calls = stubFetch(() => textBlockResponse('не должно вызываться'));

    const result = await generateSessionTitle(LONG_PROMPT);

    assert.equal(calls.length, 0);
    assert.equal(result?.generated, false);
    assert.equal(result?.title, buildFallbackTitle(LONG_PROMPT));
  });

  it('retries with extended thinking when the gateway demands it', async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'gateway-token';
    const calls = stubFetch((_url, init) => {
      const body = JSON.parse(String(init.body)) as { thinking?: unknown };
      if (!body.thinking) {
        return jsonResponse(
          {
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: '`clear_thinking_20251015` strategy requires `thinking` to be enabled or adaptive',
            },
          },
          400,
        );
      }

      // Thinking responses carry a reasoning block next to the answer.
      return jsonResponse({
        content: [
          { type: 'thinking', thinking: 'рассуждение' },
          { type: 'text', text: 'CloudCLI — боковая панель сеансов' },
        ],
      });
    });

    const result = await generateSessionTitle(LONG_PROMPT);

    assert.equal(calls.length, 2, 'expected a plain attempt followed by a thinking retry');
    const retryBody = JSON.parse(String(calls[1]?.init.body)) as {
      thinking?: { type?: string; budget_tokens?: number };
      max_tokens?: number;
      temperature?: number;
    };
    assert.equal(retryBody.thinking?.type, 'enabled');
    // The API rejects a thinking budget that is not below max_tokens.
    assert.ok((retryBody.max_tokens ?? 0) > (retryBody.thinking?.budget_tokens ?? 0));
    assert.equal(retryBody.temperature, undefined);
    assert.equal(result?.title, 'CloudCLI — боковая панель сеансов');
    assert.equal(result?.generated, true);
  });

  it('gives up after the thinking retry also fails', async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'gateway-token';
    const calls = stubFetch((_url, init) => {
      const body = JSON.parse(String(init.body)) as { thinking?: unknown };
      return body.thinking
        ? jsonResponse({ error: 'still broken' }, 500)
        : jsonResponse(
            { error: { message: '`clear_thinking_20251015` strategy requires `thinking` to be enabled' } },
            400,
          );
    });

    const result = await generateSessionTitle(LONG_PROMPT);

    assert.equal(calls.length, 2);
    assert.equal(result?.title, buildFallbackTitle(LONG_PROMPT));
    assert.equal(result?.generated, false);
  });

  it('does not retry on unrelated 400 errors', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const calls = stubFetch(() => jsonResponse({ error: { message: 'model not found' } }, 400));

    const result = await generateSessionTitle(LONG_PROMPT);

    assert.equal(calls.length, 1);
    assert.equal(result?.generated, false);
  });

  it('serializes concurrent title requests so the gateway is never flooded', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    let inFlight = 0;
    let peakInFlight = 0;

    stubFetch(async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return textBlockResponse('Проект — задача');
    });

    const prompts = Array.from({ length: 5 }, (_, index) => `${LONG_PROMPT} вариант ${index}`);
    const results = await Promise.all(prompts.map((prompt) => generateSessionTitle(prompt)));

    assert.equal(peakInFlight, 1, `expected serialized requests, saw ${peakInFlight} in flight`);
    assert.equal(results.length, 5);
    assert.ok(results.every((result) => result?.generated === true));
  });

  it('returns null for an empty prompt', async () => {
    assert.equal(await generateSessionTitle('   '), null);
  });
});
