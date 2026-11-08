import assert from 'node:assert/strict';
import test from 'node:test';

import { listApiModels, listSmallModels, type SmallModelCredentials } from '@/shared/small-model.js';

const credentials: SmallModelCredentials = { baseUrl: 'https://models.example.invalid', token: 'fixture-key-only', isApiKey: true };
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

test('для меню шлюза запрашиваются обычные ID без Anthropic-маскировки', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), `Bearer ${credentials.token}`);
    assert.equal(headers.has('anthropic-version'), false);
    assert.equal(headers.has('x-api-key'), false);
    return json({ data: [{ id: 'gpt-6.1-sol' }] });
  });
  assert.deepEqual(await listApiModels(credentials, { timeoutMs: 1000, preferStandardIds: true }), [{ id: 'gpt-6.1-sol', label: 'gpt-6.1-sol' }]);
});

test('API, требующий Anthropic-заголовки, получает безопасный повтор в тот же endpoint', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    assert.equal(new URL(String(input)).origin, credentials.baseUrl);
    const headers = new Headers(init?.headers);
    if (++calls === 1) return new Response('fixture: use x-api-key', { status: 401 });
    assert.equal(headers.get('x-api-key'), credentials.token);
    assert.equal(headers.get('anthropic-version'), '2023-06-01');
    assert.equal(headers.has('authorization'), false);
    return json({ data: [{ id: 'native-id' }] });
  });
  assert.equal((await listApiModels(credentials, { timeoutMs: 1000, preferStandardIds: true }))?.[0].id, 'native-id');
  assert.equal(calls, 2);
});

test('официальный Anthropic сразу использует свой протокол без лишнего запроса', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
    calls++;
    assert.equal(new Headers(init?.headers).get('x-api-key'), credentials.token);
    assert.equal(new Headers(init?.headers).get('anthropic-version'), '2023-06-01');
    return json({ data: [{ id: 'claude-model' }] });
  });
  await listApiModels({ ...credentials, baseUrl: 'https://api.anthropic.com' }, { timeoutMs: 1000, preferStandardIds: true });
  assert.equal(calls, 1);
});

test('ограничение частоты не вызывает дополнительный запрос с другим протоколом', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('', { status: 429 }); });
  assert.equal(await listApiModels(credentials, { timeoutMs: 1000, preferStandardIds: true }), null);
  assert.equal(calls, 1);
});

test('API-каталог сохраняет произвольные ID, подписи, порядок и убирает повторы', async (t) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return json({ data: [
      { id: 'vendor/new-model', display_name: 'Новая модель' },
      { id: 'gpt-image-fixture', name: 'Изображения API' },
      { id: 'vendor/new-model', display_name: 'Дубликат' },
      { id: 'id-without-name' }, { id: ' ' }, { id: 42 }, null,
    ] });
  });
  assert.deepEqual(await listApiModels(credentials, { timeoutMs: 1000 }), [
    { id: 'vendor/new-model', label: 'Новая модель' },
    { id: 'gpt-image-fixture', label: 'Изображения API' },
    { id: 'id-without-name', label: 'id-without-name' },
  ]);
  assert.equal(calls[0].url, `${credentials.baseUrl}/v1/models?limit=1000`);
  const headers = new Headers(calls[0].init?.headers);
  assert.equal(headers.get('x-api-key'), credentials.token);
  assert.equal(headers.has('authorization'), false);
  assert.equal(calls[0].init?.redirect, 'error');
});

test('Bearer credentials и baseUrl с /v1 используют тот же endpoint без двойного /v1', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    assert.equal(String(input), 'https://models.example.invalid/custom/v1/models?limit=1000');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer fixture-key-only');
    assert.equal(headers.has('x-api-key'), false);
    return json({ data: [{ id: 'model' }] });
  });
  await listApiModels({ ...credentials, baseUrl: 'https://models.example.invalid/custom/v1/', isApiKey: false }, { timeoutMs: 1000 });
});

test('пагинация читает все страницы только в настроенном origin', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input: unknown) => {
    const url = new URL(String(input));
    assert.equal(url.origin, credentials.baseUrl);
    calls++;
    if (calls === 1) return json({ data: [{ id: 'one' }], has_more: true, last_id: 'cursor/one', next: 'https://attacker.invalid/steal' });
    assert.equal(url.searchParams.get('after_id'), 'cursor/one');
    return json({ data: [{ id: 'two', display_name: 'Вторая' }], has_more: false });
  });
  assert.deepEqual((await listApiModels(credentials, { timeoutMs: 1000 }))?.map((m) => m.id), ['one', 'two']);
  assert.equal(calls, 2);
});

test('повтор курсора не зацикливает запросы и не выдаёт частичный список', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return json({ data: [{ id: 'one' }], has_more: true, last_id: 'same' }); });
  assert.equal(await listApiModels(credentials, { timeoutMs: 1000 }), null);
  assert.equal(calls, 2);
});

test('невалидный JSON, структура ответа и HTTP-ошибки дают безопасный fallback', async (t) => {
  let response: Response;
  t.mock.method(globalThis, 'fetch', async () => response);
  for (response of [new Response('{'), json({ models: [] }), new Response('fixture failure', { status: 401 })]) {
    assert.equal(await listApiModels(credentials, { timeoutMs: 1000 }), null);
  }
});

test('таймаут отменяет запрос каталога', async (t) => {
  let aborted = false;
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('fixture abort')); }, { once: true });
  }));
  assert.equal(await listApiModels(credentials, { timeoutMs: 20 }), null);
  assert.equal(aborted, true);
});

test('список ID для сводки использует общий транспорт без фильтрации внутри него', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({ data: [{ id: 'claude-haiku-5-5' }, { id: 'wrapped-other-model' }] }));
  assert.deepEqual(await listSmallModels(credentials, { timeoutMs: 1000 }), ['claude-haiku-5-5', 'wrapped-other-model']);
});
