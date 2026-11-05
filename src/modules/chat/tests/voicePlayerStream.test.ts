import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { synthesizeVoice } from '@/shared/api';
import { voiceId, voicePlayer } from '@/modules/chat/utils/voicePlayer';

// GOLDJAXE fork (реестр §4.15): read-aloud plays while the MP3 downloads.

vi.mock('@/shared/api', () => ({
  synthesizeVoice: vi.fn(),
  voiceConfigSignature: () => 'test-signature',
}));

const synthesize = vi.mocked(synthesizeVoice);

class FakeSourceBuffer extends EventTarget {
  appended: number[][] = [];

  appendBuffer(chunk: Uint8Array) {
    this.appended.push([...chunk]);
    queueMicrotask(() => this.dispatchEvent(new Event('updateend')));
  }
}

class FakeMediaSource extends EventTarget {
  static isTypeSupported = (type: string) => type === 'audio/mpeg';
  static last: FakeMediaSource | null = null;
  readyState: 'closed' | 'open' | 'ended' = 'closed';
  buffer: FakeSourceBuffer | null = null;

  constructor() {
    super();
    FakeMediaSource.last = this;
  }

  addSourceBuffer() {
    this.buffer = new FakeSourceBuffer();
    return this.buffer;
  }

  endOfStream() {
    this.readyState = 'ended';
  }
}

let objectUrlCounter = 0;
const createdBlobs: Blob[] = [];

function mp3Response(chunks: number[][], signal?: AbortSignal, hold = false): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
      if (!hold) controller.close();
      signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
    },
  });
  return new Response(body, { headers: { 'content-type': 'audio/mpeg' } });
}

const snapshot = (content: string) => voicePlayer.getSnapshot(voiceId(content));

beforeEach(() => {
  objectUrlCounter = 0;
  createdBlobs.length = 0;
  FakeMediaSource.last = null;
  vi.stubGlobal('MediaSource', FakeMediaSource);
  URL.createObjectURL = vi.fn((source: Blob | MediaSource) => {
    if (source instanceof FakeMediaSource) {
      queueMicrotask(() => {
        source.readyState = 'open';
        source.dispatchEvent(new Event('sourceopen'));
      });
    } else {
      createdBlobs.push(source as Blob);
    }
    objectUrlCounter += 1;
    return `blob:test/${objectUrlCounter}`;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  synthesize.mockReset();
});

afterEach(() => {
  voicePlayer.stop();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('voicePlayer streaming', () => {
  it('starts playing on the first chunk and caches the whole file for a replay', async () => {
    const content = 'Потоковая озвучка: первый кусок звука';
    synthesize.mockImplementation(async () => mp3Response([[1, 2], [3], [4, 5]]));

    voicePlayer.toggle(content);
    await vi.waitFor(() => expect(snapshot(content).state).toBe('playing'));
    await vi.waitFor(() => expect(FakeMediaSource.last?.readyState).toBe('ended'));

    expect(FakeMediaSource.last?.buffer?.appended).toEqual([[1, 2], [3], [4, 5]]);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    // The finished file is kept as one MP3 blob.
    expect(createdBlobs).toHaveLength(1);
    expect(createdBlobs[0]?.type).toBe('audio/mpeg');
    expect(createdBlobs[0]?.size).toBe(5);

    // A replay comes from the cache, not from the network.
    voicePlayer.stop();
    voicePlayer.toggle(content);
    await vi.waitFor(() => expect(snapshot(content).state).toBe('playing'));
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it('keeps appending while play() waits for more audio', async () => {
    // Chrome with Edge TTS: play() on a single 720-byte chunk resolves only once
    // the next chunks are in. Awaiting it inside the loop hung forever.
    const content = 'Первый кусок слишком короткий для старта';
    let release: () => void = () => {};
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    synthesize.mockImplementation(async () => mp3Response([[1], [2], [3]]));

    voicePlayer.toggle(content);
    await vi.waitFor(() => expect(FakeMediaSource.last?.buffer?.appended).toHaveLength(3));
    expect(snapshot(content).state).toBe('loading');
    release();
    await vi.waitFor(() => expect(snapshot(content).state).toBe('playing'));
    await vi.waitFor(() => expect(createdBlobs).toHaveLength(1));
  });

  it('a failed play() aborts the download and shows the error at once', async () => {
    const content = 'Браузер отказался играть';
    let requestSignal: AbortSignal | undefined;
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValue(new Error('play() was blocked'));
    synthesize.mockImplementation(async (_text, signal) => {
      requestSignal = signal;
      return mp3Response([[1]], signal, true);
    });

    voicePlayer.toggle(content);
    await vi.waitFor(() => expect(snapshot(content).error).toBe('play() was blocked'));
    expect(snapshot(content).state).toBe('idle');
    expect(requestSignal?.aborted).toBe(true);
    expect(createdBlobs).toHaveLength(0);
  });

  it('falls back to the whole file where MediaSource is missing', async () => {
    vi.stubGlobal('MediaSource', undefined);
    const content = 'Озвучка целым файлом без MediaSource';
    synthesize.mockImplementation(async () => mp3Response([[7, 8, 9]]));

    voicePlayer.toggle(content);
    await vi.waitFor(() => expect(snapshot(content).state).toBe('playing'));

    expect(FakeMediaSource.last).toBeNull();
    expect(createdBlobs).toHaveLength(1);
    expect(createdBlobs[0]?.size).toBe(3);
  });

  it('stop cancels a stream that is still downloading, without an error', async () => {
    const content = 'Остановка посреди потока';
    let requestSignal: AbortSignal | undefined;
    synthesize.mockImplementation(async (_text, signal) => {
      requestSignal = signal;
      return mp3Response([[1]], signal, true);
    });

    voicePlayer.toggle(content);
    await vi.waitFor(() => expect(snapshot(content).state).toBe('playing'));

    voicePlayer.toggle(content); // second tap = stop
    expect(snapshot(content)).toEqual({ state: 'idle', error: null });
    expect(requestSignal?.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(snapshot(content).error).toBeNull();
  });

  it('shows the backend error text instead of a bare status', async () => {
    const content = 'Озвучка выключена на сервере';
    synthesize.mockImplementation(async () => new Response(
      JSON.stringify({ detail: 'Озвучка на этом сервере выключена', error: 'Озвучка на этом сервере выключена' }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    ));

    voicePlayer.toggle(content);
    await vi.waitFor(() => expect(snapshot(content).error).toBe('Озвучка на этом сервере выключена'));
    expect(snapshot(content).state).toBe('idle');
  });
});
