import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { transcribeVoice } from '@/shared/api';
import { useVoiceInput } from '@/modules/chat/hooks/useVoiceInput';
import {
  flushVoiceOutbox,
  isTransientStatus,
  resetVoiceDeliveryForTests,
  transcribeTimeoutMs,
  transcribeWithRetries,
  VOICE_OUTBOX_MAX_ATTEMPTS,
  VOICE_OUTBOX_TTL_MS,
} from '@/modules/chat/utils/voiceDelivery';
import {
  createMemoryVoiceOutboxStore,
  setVoiceOutboxStoreForTests,
  type VoiceOutboxRecord,
  type VoiceOutboxStore,
} from '@/modules/chat/utils/voiceOutbox';

vi.mock('@/shared/api', () => ({
  transcribeVoice: vi.fn(),
  warmUpVoiceBackend: vi.fn(),
}));

const transcribeMock = vi.mocked(transcribeVoice);

const audio = (bytes = 2000) => new Blob([new Uint8Array(bytes)], { type: 'audio/webm' });
const okResponse = (text: string) => new Response(JSON.stringify({ text }), { status: 200 });
const errorResponse = (status: number, error = 'nope') => new Response(JSON.stringify({ error }), { status });

let store: VoiceOutboxStore;

async function addPending(id: string, options: { createdAt?: number; bytes?: number; permanent?: boolean } = {}) {
  await store.begin({ id, createdAt: options.createdAt ?? Date.now(), mimeType: 'audio/webm', filename: 'recording.webm' });
  await store.appendChunk(id, 0, audio(options.bytes));
  await store.update(id, { status: 'pending', durationMs: 5000, permanent: options.permanent ?? false });
}

beforeEach(() => {
  store = createMemoryVoiceOutboxStore();
  setVoiceOutboxStoreForTests(store);
  resetVoiceDeliveryForTests();
  transcribeMock.mockReset();
});

afterEach(() => {
  setVoiceOutboxStoreForTests(null);
  vi.restoreAllMocks();
});

describe('политика повторов', () => {
  it('повторяет транспортные и серверные сбои, но не отказ по ключу или запросу', () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) expect(isTransientStatus(status)).toBe(true);
    for (const status of [400, 401, 403, 404, 413, 415, 422]) expect(isTransientStatus(status)).toBe(false);
  });

  it('таймаут растёт с длиной аудио в пределах минуты и пяти минут', () => {
    expect(transcribeTimeoutMs(0)).toBe(60_000);
    expect(transcribeTimeoutMs(10 * 60_000)).toBe(180_000);
    expect(transcribeTimeoutMs(60 * 60_000)).toBe(300_000);
  });

  it('повторяет сетевой сбой и возвращает текст со второй попытки', async () => {
    transcribeMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(okResponse('привет'));
    const onRetry = vi.fn();
    const outcome = await transcribeWithRetries(audio(), 'recording.webm', {
      idempotencyKey: 'rec-1',
      durationMs: 1000,
      delays: [0, 0],
      onRetry,
    });
    expect(outcome).toMatchObject({ ok: true, text: 'привет', attempts: 2 });
    expect(onRetry).toHaveBeenCalledWith(2, 3);
    expect(transcribeMock.mock.calls[0][2]).toMatchObject({ idempotencyKey: 'rec-1' });
  });

  it('не повторяет отказ, который повтором не лечится', async () => {
    transcribeMock.mockResolvedValue(errorResponse(401, 'bad key'));
    const outcome = await transcribeWithRetries(audio(), 'recording.webm', {
      idempotencyKey: 'rec-1',
      durationMs: 1000,
      delays: [0, 0],
    });
    expect(outcome).toMatchObject({ ok: false, transient: false, attempts: 1, message: 'HTTP 401: bad key' });
    expect(transcribeMock).toHaveBeenCalledTimes(1);
  });

  it('обрывает запрос, как только пропала сеть, и не ждёт таймаута', async () => {
    transcribeMock.mockImplementation((_blob, _name, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const pending = transcribeWithRetries(audio(), 'recording.webm', {
      idempotencyKey: 'rec-1',
      durationMs: 1000,
      delays: [0, 0],
    });
    await Promise.resolve();
    window.dispatchEvent(new Event('offline'));
    const outcome = await pending;
    expect(outcome).toMatchObject({ ok: false, transient: true, offline: true, attempts: 1 });
  });
});

describe('фоновая досылка очереди', () => {
  it('досылает запись, вручает текст и убирает её из очереди', async () => {
    await addPending('rec-1');
    transcribeMock.mockResolvedValue(okResponse('длинная мысль'));
    const deliver = vi.fn(() => true);

    await flushVoiceOutbox(deliver);

    expect(deliver).toHaveBeenCalledWith('длинная мысль', expect.objectContaining({ id: 'rec-1' }));
    expect(transcribeMock.mock.calls[0][2]).toMatchObject({ idempotencyKey: 'rec-1' });
    expect(await store.list()).toEqual([]);
  });

  it('при сетевой беде оставляет запись и не долбит канал остальными', async () => {
    await addPending('old', { createdAt: Date.now() - 2000 });
    await addPending('new', { createdAt: Date.now() - 1000 });
    transcribeMock.mockResolvedValue(errorResponse(503));

    await flushVoiceOutbox(() => true);

    expect(transcribeMock).toHaveBeenCalledTimes(1);
    const [old, fresh] = await store.list();
    expect(old).toMatchObject({ id: 'old', attempts: 1, permanent: false });
    expect(old.lastError).toContain('HTTP 503');
    expect(fresh).toMatchObject({ id: 'new', attempts: 0 });
  });

  it('безнадёжный отказ фон больше не трогает, а кнопка «Отправить» — шлёт', async () => {
    await addPending('rec-1');
    transcribeMock.mockResolvedValueOnce(errorResponse(401));
    await flushVoiceOutbox(() => true);
    expect(await store.get('rec-1')).toMatchObject({ permanent: true, attempts: 1 });

    await flushVoiceOutbox(() => true);
    expect(transcribeMock).toHaveBeenCalledTimes(1);

    transcribeMock.mockResolvedValueOnce(okResponse('текст'));
    const deliver = vi.fn(() => true);
    await flushVoiceOutbox(deliver, { onlyId: 'rec-1', force: true });
    expect(deliver).toHaveBeenCalledWith('текст', expect.anything());
    expect(await store.get('rec-1')).toBeNull();
  });

  it('после лимита неудач запись выпадает из фоновых повторов', async () => {
    await addPending('rec-1');
    await store.update('rec-1', { attempts: VOICE_OUTBOX_MAX_ATTEMPTS - 1 });
    transcribeMock.mockResolvedValue(errorResponse(502));
    await flushVoiceOutbox(() => true);
    expect(await store.get('rec-1')).toMatchObject({ permanent: true });
  });

  it('если вручить некому, запись остаётся до следующего композера', async () => {
    await addPending('rec-1');
    transcribeMock.mockResolvedValue(okResponse('текст'));
    await flushVoiceOutbox(() => false);
    expect(await store.get('rec-1')).not.toBeNull();
  });

  it('без сети не делает ни одного запроса', async () => {
    await addPending('rec-1');
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await flushVoiceOutbox(() => true);
    expect(transcribeMock).not.toHaveBeenCalled();
    expect(await store.get('rec-1')).toMatchObject({ attempts: 0 });
  });

  it('подхватывает запись, брошенную посреди диктовки, но не трогает идущую', async () => {
    const now = Date.now();
    await store.begin({ id: 'dead', createdAt: now - 120_000, mimeType: 'audio/webm', filename: 'recording.webm' });
    await store.appendChunk('dead', 0, audio());
    await store.update('dead', { updatedAt: now - 60_000 });
    await store.begin({ id: 'live', createdAt: now - 5_000, mimeType: 'audio/webm', filename: 'recording.webm' });
    await store.appendChunk('live', 0, audio());
    transcribeMock.mockResolvedValue(okResponse('спасённое'));
    const deliver = vi.fn((_text: string, _record: VoiceOutboxRecord) => true);

    await flushVoiceOutbox(deliver);

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][1]).toMatchObject({ id: 'dead', status: 'pending', durationMs: 60_000 });
    expect((await store.list()).map((record) => record.id)).toEqual(['live']);
  });

  it('убирает просроченные записи', async () => {
    await addPending('stale', { createdAt: Date.now() - VOICE_OUTBOX_TTL_MS - 1000 });
    transcribeMock.mockResolvedValue(okResponse('x'));
    await flushVoiceOutbox(() => true);
    expect(transcribeMock).not.toHaveBeenCalled();
    expect(await store.list()).toEqual([]);
  });
});

//----------------- ХУК ДИКТОВКИ ------------

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = (type: string) => type === 'audio/webm;codecs=opus';
  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(_stream: unknown, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? 'audio/webm';
    FakeMediaRecorder.instances.push(this);
  }

  start() {
    this.state = 'recording';
  }

  emit(bytes: number) {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)], { type: this.mimeType }) });
  }

  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    this.emit(500);
    setTimeout(() => this.onstop?.(), 0);
  }
}

describe('useVoiceInput и очередь', () => {
  beforeEach(() => {
    FakeMediaRecorder.instances = [];
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: () => {} }] })) },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function recordSomething(result: { current: ReturnType<typeof useVoiceInput> }) {
    await act(async () => {
      result.current.toggle();
    });
    await waitFor(() => expect(result.current.state).toBe('recording'));
    const recorder = FakeMediaRecorder.instances.at(-1)!;
    await act(async () => {
      recorder.emit(1500);
      recorder.emit(1500);
    });
    return recorder;
  }

  it('звонок оборвал сеть на отправке: надиктовка ждёт и доходит, когда связь вернулась', async () => {
    const onTranscript = vi.fn();
    const onNotice = vi.fn();
    const { result } = renderHook(() => useVoiceInput(onTranscript, vi.fn(), { onNotice, outboxEnabled: true }));

    await recordSomething(result);
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await act(async () => {
      result.current.stop({ send: true });
    });
    await waitFor(() => expect(result.current.state).toBe('idle'));

    expect(onTranscript).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenCalledWith('voice.outbox.savedOffline');
    const [saved] = await store.list();
    expect(saved).toMatchObject({ status: 'pending', size: 3500, lastError: 'offline' });
    expect((await store.readAudio(saved.id))?.size).toBe(3500);
    await waitFor(() => expect(result.current.outbox.items).toHaveLength(1));

    onLine.mockReturnValue(true);
    transcribeMock.mockResolvedValue(okResponse('десять минут речи'));
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    // Отложенный текст встаёт в поле, но сам не отправляется.
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith('десять минут речи', false));
    expect(transcribeMock.mock.calls[0][2]).toMatchObject({ idempotencyKey: saved.id });
    await waitFor(() => expect(result.current.outbox.items).toHaveLength(0));
    expect(await store.list()).toEqual([]);
  });

  it('обычный путь: текст вручается сразу, очередь пуста', async () => {
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useVoiceInput(onTranscript, vi.fn(), { outboxEnabled: true }));
    transcribeMock.mockResolvedValue(okResponse('быстро'));

    await recordSomething(result);
    await act(async () => {
      result.current.stop({ send: true });
    });

    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith('быстро', true));
    await waitFor(() => expect(result.current.state).toBe('idle'));
    expect(await store.list()).toEqual([]);
  });

  it('композер ушёл посреди диктовки: записанное остаётся в очереди', async () => {
    const { result, unmount } = renderHook(() => useVoiceInput(vi.fn(), vi.fn(), { outboxEnabled: true }));
    await recordSomething(result);

    unmount();

    await waitFor(async () => expect(await store.list()).toHaveLength(1));
    const [saved] = await store.list();
    await waitFor(async () => expect((await store.get(saved.id))?.status).toBe('pending'));
    expect(transcribeMock).not.toHaveBeenCalled();
    expect((await store.readAudio(saved.id))?.size).toBe(3500);
  });
});
