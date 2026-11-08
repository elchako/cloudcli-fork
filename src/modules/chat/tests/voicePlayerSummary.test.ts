import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, synthesizeVoice } from '@/shared/api';
import { loadSpeechSummaryModels, resetSpeechSummaryStatusForTests } from '@/shared/speechSummary';
import { seedVoiceConfigCacheForTests } from '@/shared/voiceConfig';
import { voiceId, voicePlayer } from '@/modules/chat/utils/voicePlayer';

// GOLDJAXE fork (реестр §4.16): read-aloud speaks a summary of a long reply.

vi.mock('@/shared/api', () => ({
  api: {
    speechSummary: { status: vi.fn(), summarize: vi.fn(), models: vi.fn() },
    getVoiceSettings: vi.fn(),
  },
  synthesizeVoice: vi.fn(),
  voiceConfigSignature: () => 'test-signature',
}));

const synthesize = vi.mocked(synthesizeVoice);
const status = vi.mocked(api.speechSummary.status);
const summarize = vi.mocked(api.speechSummary.summarize);

// The player caches audio per text for the whole module, so every test gets
// its own reply — otherwise a later test would just replay the cache.
let replyCounter = 0;
const longReply = () => `${'Подробности и перечень изменённых мест. '.repeat(30)}Ответ №${++replyCounter}. Нужно твоё решение.`;
const snapshot = (content: string) => voicePlayer.getSnapshot(voiceId(content));

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init });
}

function audioResponse(): Response {
  // No MediaSource in jsdom: the whole-file path plays it.
  return new Response(new Blob([new Uint8Array([1, 2, 3])]), { headers: { 'content-type': 'audio/mpeg' } });
}

const STATUS = { available: true, enabled: true, model: 'claude-haiku', defaultPrompt: 'Стандарт', minChars: 700 };

beforeEach(() => {
  resetSpeechSummaryStatusForTests();
  seedVoiceConfigCacheForTests({});
  status.mockReset();
  summarize.mockReset();
  synthesize.mockReset();
  status.mockImplementation(async () => json(STATUS));
  synthesize.mockImplementation(async () => audioResponse());
  URL.createObjectURL = vi.fn(() => 'blob:test/1') as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});

afterEach(() => {
  voicePlayer.stop();
  vi.restoreAllMocks();
});

describe('voicePlayer summary', () => {
  it('speaks the summary of a long reply', async () => {
    const LONG_REPLY = longReply();
    summarize.mockImplementation(async () => json({ summary: 'Сделал. Нужно твоё решение.' }));
    voicePlayer.toggle(LONG_REPLY);
    await vi.waitFor(() => expect(snapshot(LONG_REPLY).state).toBe('playing'));
    expect(summarize).toHaveBeenCalledWith(LONG_REPLY, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(synthesize).toHaveBeenCalledWith('Сделал. Нужно твоё решение.', expect.any(AbortSignal));
  });

  it('turning the summary on in the settings works without a page reload', async () => {
    // The settings screen cached the status while the summary was off.
    status.mockImplementation(async () => json({ ...STATUS, enabled: false }));
    seedVoiceConfigCacheForTests({ speechSummary: 'on' });
    summarize.mockImplementation(async () => json({ summary: 'Сводка после включения.' }));
    const LONG_REPLY = longReply();
    voicePlayer.toggle(LONG_REPLY);
    await vi.waitFor(() => expect(snapshot(LONG_REPLY).state).toBe('playing'));
    expect(synthesize).toHaveBeenCalledWith('Сводка после включения.', expect.any(AbortSignal));
  });

  it('reads a short reply as it is, without asking for a summary', async () => {
    const short = 'Готово, проверь, пожалуйста.';
    voicePlayer.toggle(short);
    await vi.waitFor(() => expect(snapshot(short).state).toBe('playing'));
    expect(summarize).not.toHaveBeenCalled();
    expect(synthesize).toHaveBeenCalledWith(short, expect.any(AbortSignal));
  });

  it('reads in full when the user switched summaries off', async () => {
    const LONG_REPLY = longReply();
    seedVoiceConfigCacheForTests({ speechSummary: 'off' });
    voicePlayer.toggle(LONG_REPLY);
    await vi.waitFor(() => expect(snapshot(LONG_REPLY).state).toBe('playing'));
    expect(status).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
    expect(synthesize).toHaveBeenCalledWith(LONG_REPLY, expect.any(AbortSignal));
  });

  it.each([
    ['no summary', async () => json({ summary: null, reason: 'unavailable' })],
    ['busy server', async () => json({ summary: null, reason: 'busy' }, { status: 429 })],
    ['network error', async () => { throw new TypeError('Failed to fetch'); }],
  ])('falls back to the full reply on %s', async (_name, reply) => {
    const LONG_REPLY = longReply();
    summarize.mockImplementation(reply);
    voicePlayer.toggle(LONG_REPLY);
    await vi.waitFor(() => expect(snapshot(LONG_REPLY).state).toBe('playing'));
    expect(synthesize).toHaveBeenCalledWith(LONG_REPLY, expect.any(AbortSignal));
    expect(snapshot(LONG_REPLY).error).toBeNull();
    expect(snapshot(LONG_REPLY).notice).toBe('summary-fallback');
  });

  it('reads in full against an older server without the summary route', async () => {
    const LONG_REPLY = longReply();
    // An older server answers unknown paths with the app's index.html.
    status.mockImplementation(async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }));
    voicePlayer.toggle(LONG_REPLY);
    await vi.waitFor(() => expect(snapshot(LONG_REPLY).state).toBe('playing'));
    expect(summarize).not.toHaveBeenCalled();
    expect(synthesize).toHaveBeenCalledWith(LONG_REPLY, expect.any(AbortSignal));
  });

  it('«Стоп» while the summary is being made cancels it, without an error or speech', async () => {
    const LONG_REPLY = longReply();
    let summarySignal: AbortSignal | undefined;
    summarize.mockImplementation((_text, options) => new Promise((_resolve, reject) => {
      summarySignal = options?.signal ?? undefined;
      summarySignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    voicePlayer.toggle(LONG_REPLY);
    await vi.waitFor(() => expect(summarySignal).toBeDefined());
    expect(snapshot(LONG_REPLY).state).toBe('loading');

    voicePlayer.toggle(LONG_REPLY); // second tap = stop
    expect(summarySignal?.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(snapshot(LONG_REPLY)).toEqual({ state: 'idle', error: null });
    expect(synthesize).not.toHaveBeenCalled();
  });
});

// GOLDJAXE fork (реестр §4.16-тер): общий каталог, метки API и обратная совместимость.
describe('loadSpeechSummaryModels', () => {
  const models = vi.mocked(api.speechSummary.models);

  it('читает IDs старого сервера и отбрасывает чужие типы', async () => {
    models.mockResolvedValueOnce(json({ models: ['claude-haiku-5-5', 7, 'gpt-6.1-sol'] }));
    expect(await loadSpeechSummaryModels()).toEqual({ models: [
      { id: 'claude-haiku-5-5', label: 'claude-haiku-5-5' }, { id: 'gpt-6.1-sol', label: 'gpt-6.1-sol' },
    ] });
  });

  it('сохраняет label/catalogProvider и прокидывает force refresh', async () => {
    const modelOptions = [{ id: 'gpt-6.1-sol', label: 'Модель API', catalogProvider: 'openai' }];
    models.mockResolvedValueOnce(json({ models: ['gpt-6.1-sol'], modelOptions, source: 'api-cache' }));
    expect(await loadSpeechSummaryModels(true)).toEqual({ models: modelOptions, source: 'api-cache' });
    expect(models).toHaveBeenLastCalledWith(true);
  });

  it('отличает пустой каталог от недоступности и работает со старым HTML-сервером', async () => {
    models.mockResolvedValueOnce(json({ models: [], modelOptions: [], source: 'api' }));
    expect(await loadSpeechSummaryModels()).toEqual({ models: [], source: 'api' });
    models.mockResolvedValueOnce(json({ models: [], modelOptions: null }));
    expect(await loadSpeechSummaryModels()).toEqual({ models: null });
    models.mockResolvedValueOnce(new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }));
    expect(await loadSpeechSummaryModels()).toEqual({ models: null });
    models.mockResolvedValueOnce(json({ error: 'x' }, { status: 500 }));
    expect(await loadSpeechSummaryModels()).toEqual({ models: null });
    models.mockRejectedValueOnce(new Error('offline'));
    expect(await loadSpeechSummaryModels()).toEqual({ models: null });
  });
});

describe('voicePlayer summary fallback limits', () => {
  it('после двух неудач читает весь исходник, а не обрезанный вход модели; уведомляет и при повторе кэша', async () => {
    const content = `${longReply()}${'Полная середина и конец. '.repeat(3000)}`;
    summarize.mockResolvedValue(json({ summary: null, reason: 'timeout' }));
    voicePlayer.toggle(content);
    await vi.waitFor(() => expect(snapshot(content).state).toBe('playing'));
    expect(synthesize).toHaveBeenCalledWith(content, expect.any(AbortSignal));
    expect(snapshot(content).notice).toBe('summary-fallback');
    voicePlayer.stop();
    voicePlayer.toggle(content);
    await vi.waitFor(() => expect(snapshot(content).state).toBe('playing'));
    expect(snapshot(content).notice).toBe('summary-fallback');
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it.each(['disabled', 'short'])('пропуск %s не показывает сообщение о сбое', async (reason) => {
    const content = longReply();
    summarize.mockResolvedValue(json({ summary: null, reason }));
    voicePlayer.toggle(content);
    await vi.waitFor(() => expect(snapshot(content).state).toBe('playing'));
    expect(snapshot(content).notice).toBeUndefined();
  });

  it('«Стоп» во время /status сразу отменяет ожидание и не запускает ни сводку, ни TTS', async () => {
    const content = longReply();
    let resolveStatus: ((response: Response) => void) | undefined;
    status.mockImplementation(() => new Promise((resolve) => { resolveStatus = resolve; }));
    voicePlayer.toggle(content);
    await vi.waitFor(() => expect(resolveStatus).toBeDefined());
    voicePlayer.stop();
    resolveStatus!(json(STATUS));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(summarize).not.toHaveBeenCalled();
    expect(synthesize).not.toHaveBeenCalled();
    expect(snapshot(content)).toEqual({ state: 'idle', error: null });
  });

  it('зависший ответ сервера ограничен клиентским backstop, после него идёт TTS полного текста', async () => {
    vi.useFakeTimers();
    try {
      const content = longReply();
      summarize.mockImplementation(() => new Promise(() => {}));
      voicePlayer.toggle(content);
      await vi.advanceTimersByTimeAsync(35_001);
      expect(synthesize).toHaveBeenCalledWith(content, expect.any(AbortSignal));
      expect(snapshot(content).notice).toBe('summary-fallback');
      expect(snapshot(content).error).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
