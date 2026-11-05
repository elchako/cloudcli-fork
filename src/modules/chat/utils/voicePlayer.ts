import { synthesizeVoice, voiceConfigSignature } from '@/shared/api';
import type { VoicePlayState, VoiceSnapshot } from '@/shared/types';

// A single app-level audio player for read-aloud. It owns one <audio> element, lives
// outside the React tree, and caches generated audio by content. Because playback is not
// tied to a component, switching chats or re-rendering a message can't revoke the blob URL
// out from under it (the cause of mid-play cutoffs). v1 plays one message at a time
// (a new play replaces the current one); the design leaves room for a queue later.


const IDLE: VoiceSnapshot = { state: 'idle', error: null };
const CACHE_MAX = 24;
const CLIENT_TIMEOUT_MS = 330000; // backstop; the server proxy already times out at 5 min

// GOLDJAXE fork (реестр §4.15): read-aloud starts with the first chunk of audio.
// Before, the whole MP3 had to download first, and synthesis runs only about
// three times faster than speech: a long reply waited a minute or more in
// silence. MediaSource plays MP3 while it arrives (Chrome, Edge, Firefox, also
// on Android); where it is missing (iPhone Safari) the whole-file path stays.
const STREAM_MIME = 'audio/mpeg';

function canStreamResponse(res: Response): boolean {
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!res.body || (type !== 'audio/mpeg' && type !== 'audio/mp3')) return false;
  try {
    return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(STREAM_MIME);
  } catch {
    return false;
  }
}

function waitForEvent(target: EventTarget, name: string): Promise<void> {
  return new Promise((resolve) => target.addEventListener(name, () => resolve(), { once: true }));
}

// A SourceBuffer takes one append at a time: the next waits for `updateend`.
function appendChunk(buffer: SourceBuffer, chunk: Uint8Array<ArrayBuffer>): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      buffer.removeEventListener('updateend', onDone);
      buffer.removeEventListener('error', onError);
    };
    const onDone = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('Read-aloud audio could not be decoded'));
    };
    buffer.addEventListener('updateend', onDone);
    buffer.addEventListener('error', onError);
    buffer.appendBuffer(chunk);
  });
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const j = await res.json();
    if (j?.error) return String(j.error);
  } catch {
    /* non-JSON error body */
  }
  return `Read-aloud failed (${res.status})`;
}

// Stable id / cache key from the text and voice settings that affect its audio (djb2).
export function voiceId(content: string, signature = voiceConfigSignature()): string {
  const input = JSON.stringify([content, signature]);
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = (((h << 5) + h) + input.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

class VoicePlayer {
  private audio: HTMLAudioElement | null = null;
  private unlocked = false;
  private cache = new Map<string, string>(); // id -> blob URL (insertion order = LRU)
  private currentId: string | null = null;
  private state: VoicePlayState = 'idle';
  private errorId: string | null = null;
  private errorMsg: string | null = null;
  private token = 0; // bumps to ignore stale in-flight results
  private activeController: AbortController | null = null; // aborts the in-flight TTS fetch
  private errorTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }

  getSnapshot(id: string): VoiceSnapshot {
    const state = this.currentId === id ? this.state : 'idle';
    const error = this.errorId === id ? this.errorMsg : null;
    if (state === 'idle' && error === null) return IDLE;
    return { state, error };
  }

  private ensureAudio(): HTMLAudioElement {
    if (!this.audio) {
      const audio = new Audio();
      audio.addEventListener('ended', () => this.onEnded());
      audio.addEventListener('error', () => {
        // Only meaningful while we believe we're playing.
        if (this.state === 'playing') this.onEnded();
      });
      this.audio = audio;
    }
    return this.audio;
  }

  // Call synchronously from the click handler so iOS grants the (reused) element playback.
  unlock() {
    if (this.unlocked) return;
    const audio = this.ensureAudio();
    try {
      const p = audio.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
      audio.pause();
    } catch {
      /* priming attempt; ignore */
    }
    this.unlocked = true;
  }

  toggle(content: string) {
    const id = voiceId(content);
    if (this.currentId === id && (this.state === 'playing' || this.state === 'loading')) {
      this.stop();
      return;
    }
    void this.play(id, content);
  }

  stop() {
    this.token++; // ignore any stale in-flight result
    this.abortActive(); // and actually cancel the network request
    if (this.audio) this.audio.pause();
    this.state = 'idle';
    this.currentId = null;
    this.emit();
  }

  private abortActive() {
    if (this.activeController) {
      this.activeController.abort();
      this.activeController = null;
    }
  }

  private onEnded() {
    this.state = 'idle';
    this.currentId = null;
    this.emit();
    // (queue auto-advance would hook in here)
  }

  private setError(id: string, msg: string) {
    this.state = 'idle';
    this.currentId = id;
    this.errorId = id;
    this.errorMsg = msg;
    this.emit();
    if (this.errorTimer) clearTimeout(this.errorTimer);
    this.errorTimer = setTimeout(() => {
      if (this.errorId === id) {
        this.errorId = null;
        this.errorMsg = null;
        if (this.currentId === id) this.currentId = null;
        this.emit();
      }
    }, 6000);
  }

  private async play(id: string, content: string) {
    const audio = this.ensureAudio();
    audio.pause();
    this.currentId = id;
    this.errorId = null;
    this.errorMsg = null;
    this.state = 'loading';
    this.emit();

    const myToken = ++this.token;
    this.abortActive(); // cancel any request this play supersedes

    try {
      let url = this.cache.get(id);
      if (!url) {
        const controller = new AbortController();
        this.activeController = controller;
        const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
        // GOLDJAXE fork (реестр §4.15): the request stays abortable until the
        // body is read, so stop() also cancels a stream that is still playing.
        try {
          const res = await synthesizeVoice(content, controller.signal);
          if (myToken !== this.token) return; // superseded by another play/stop
          if (!res.ok) throw new Error(await readErrorMessage(res));
          if (canStreamResponse(res)) {
            await this.playStream(id, res.body as ReadableStream<Uint8Array<ArrayBuffer>>, audio, myToken);
            return;
          }
          const blob = await res.blob();
          if (myToken !== this.token) return;
          url = URL.createObjectURL(blob);
          this.cacheSet(id, url);
        } finally {
          clearTimeout(timer);
          if (this.activeController === controller) this.activeController = null;
        }
      }
      if (myToken !== this.token) return;
      audio.src = url;
      audio.load();
      await audio.play();
      if (myToken !== this.token) return;
      this.state = 'playing';
      this.emit();
    } catch (e) {
      if (myToken !== this.token) return;
      const aborted = e instanceof Error && e.name === 'AbortError';
      this.setError(id, aborted ? 'Read-aloud timed out.' : e instanceof Error ? e.message : 'Read-aloud failed');
    }
  }

  /**
   * GOLDJAXE fork (реестр §4.15): feeds the MP3 into a MediaSource as it arrives
   * and starts playing on the first chunk. The finished file is cached as a
   * blob, so a replay is instant and needs no network.
   */
  private async playStream(
    id: string,
    body: ReadableStream<Uint8Array<ArrayBuffer>>,
    audio: HTMLAudioElement,
    myToken: number,
  ) {
    const mediaSource = new MediaSource();
    const streamUrl = URL.createObjectURL(mediaSource);
    audio.src = streamUrl;
    await waitForEvent(mediaSource, 'sourceopen');
    URL.revokeObjectURL(streamUrl); // attached to the element; the URL itself is spent
    const reader = body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let playing = false;
    try {
      if (myToken !== this.token) return;
      const buffer = mediaSource.addSourceBuffer(STREAM_MIME);
      for (;;) {
        const { done, value } = await reader.read();
        if (myToken !== this.token) return;
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        chunks.push(value);
        await appendChunk(buffer, value);
        if (myToken !== this.token) return;
        if (!playing) {
          playing = true;
          await audio.play();
          if (myToken !== this.token) return;
          this.state = 'playing';
          this.emit();
        }
      }
    } finally {
      // Superseded mid-stream: drop the rest of the download.
      if (myToken !== this.token) void reader.cancel().catch(() => {});
    }
    if (!playing) throw new Error('Read-aloud returned no audio');
    if (mediaSource.readyState === 'open') mediaSource.endOfStream();
    this.cacheSet(id, URL.createObjectURL(new Blob(chunks, { type: STREAM_MIME })));
  }

  private cacheSet(id: string, url: string) {
    this.cache.set(id, url);
    while (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const oldUrl = this.cache.get(oldest);
      this.cache.delete(oldest);
      if (oldUrl && oldUrl !== this.audio?.src) URL.revokeObjectURL(oldUrl);
    }
  }
}

export const voicePlayer = new VoicePlayer();
