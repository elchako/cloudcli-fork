import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { warmUpVoiceBackend } from '@/shared/api';
import type { VoiceInputState } from '@/shared/types';
import { useAuth } from '@/modules/auth';
import { useVoiceOutbox, type VoiceOutboxControls } from '@/modules/chat/hooks/useVoiceOutbox';
import {
  transcribeWithRetries,
  VOICE_MIN_AUDIO_BYTES,
  type TranscribeOutcome,
} from '@/modules/chat/utils/voiceDelivery';
import {
  formatVoiceDuration,
  getVoiceOutboxStore,
  holdVoiceRecordLock,
  notifyVoiceOutboxChanged,
  type VoiceOutboxPatch,
  type VoiceOutboxRecord,
  voiceOutboxOwnerOf,
} from '@/shared/voiceOutbox';

// Mobile-safe recording: iOS Safari 18.4+ supports webm/opus; older iOS needs mp4.
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
];

// Шаг нарезки MediaRecorder: чанк раз в секунду. Кодирование размазывается по
// времени записи, поэтому на stop() остаётся дописать лишь последний фрагмент.
// Тот же чанк сразу ложится в очередь надиктовок (§4.14).
const RECORDER_TIMESLICE_MS = 1000;

function pickMime(): string {
  for (const t of MIME_CANDIDATES) {
    try {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
    } catch {
      /* isTypeSupported can throw on some iOS versions */
    }
  }
  return '';
}

function extensionFor(type: string): string {
  return type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
}

function newRecordingId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* randomUUID есть только в защищённом контексте */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Одна диктовка в работе. Все записи в очередь идут цепочкой `chain`: создать
 * запись → чанки по порядку → закрыть. Цепочка никогда не отклоняется — сбой
 * страховки отмечается в `persistFailed` и не мешает самой диктовке.
 */
type ActiveRecording = {
  id: string;
  owner: string;
  startedAt: number;
  type: string;
  filename: string;
  seq: number;
  chain: Promise<void>;
  release: () => void;
  persistFailed: boolean;
};

function persist(active: ActiveRecording, step: () => Promise<void>): void {
  active.chain = active.chain
    .then(() => (active.persistFailed ? undefined : step()))
    .catch((error) => {
      if (!active.persistFailed) console.warn('[voice-outbox] failed to persist dictation:', error);
      active.persistFailed = true;
    });
}

/**
 * Гарантирует, что надиктовка целиком лежит в очереди. Если по ходу записи
 * часть чанков не легла, кладёт всё аудио из памяти одним куском. `false` —
 * сохранить не удалось вовсе, страховки нет.
 */
async function ensurePersisted(active: ActiveRecording, blob: Blob, durationMs: number): Promise<boolean> {
  const store = getVoiceOutboxStore();
  try {
    if (active.persistFailed) {
      await store.begin({
        id: active.id,
        owner: active.owner,
        createdAt: active.startedAt,
        mimeType: active.type,
        filename: active.filename,
      });
      await store.replaceAudio(active.id, blob);
      await store.update(active.id, { status: 'pending', durationMs });
      active.persistFailed = false;
    }
    return (await store.get(active.id)) !== null;
  } catch (error) {
    console.warn('[voice-outbox] failed to keep dictation for retry:', error);
    return false;
  }
}

/** Не дошло: запись остаётся в очереди с причиной и числом попыток. */
async function keepInOutbox(
  active: ActiveRecording,
  blob: Blob,
  durationMs: number,
  outcome: Extract<TranscribeOutcome, { ok: false }> & { attempts: number },
): Promise<boolean> {
  if (!(await ensurePersisted(active, blob, durationMs))) return false;
  const patch: VoiceOutboxPatch = {
    attempts: outcome.attempts,
    lastError: outcome.offline ? 'offline' : outcome.message,
    lastAttemptAt: Date.now(),
    permanent: !outcome.transient,
  };
  try {
    await getVoiceOutboxStore().update(active.id, patch);
  } catch {
    /* запись уже в очереди — без счётчика попыток она всё равно уйдёт */
  }
  return true;
}

type VoiceInputOptions = {
  /** Нейтральные сообщения: идёт повтор, надиктовка отложена, отложенная дошла. */
  onNotice?: (msg: string) => void;
  /** Можно ли досылать очередь (голос настроен и композер показывает микрофон). */
  outboxEnabled?: boolean;
};

/**
 * Push-to-talk dictation. Records the mic, uploads to /api/voice/transcribe
 * (an OpenAI-compatible speech-to-text backend via the Express proxy), and
 * returns the transcript through onTranscript.
 *
 * GOLDJAXE fork (реестр §4.14): запись по ходу диктовки ложится в очередь
 * надиктовок (IndexedDB). Не дошла до распознавания — сеть, звонок, закрытая
 * вкладка — остаётся там, и её дошлёт фон; текст тогда встаёт в поле ввода, но
 * сам не отправляется.
 */
export function useVoiceInput(
  onTranscript: (text: string, send?: boolean) => void,
  onError?: (msg: string) => void,
  options: VoiceInputOptions = {},
): { state: VoiceInputState; toggle: () => void; stop: (opts?: { send?: boolean }) => void; outbox: VoiceOutboxControls } {
  const { t } = useTranslation('chat');
  // Очередь общая на браузер — запись помечается вошедшим пользователем (§4.14).
  const { user } = useAuth();
  const owner = voiceOutboxOwnerOf(user);
  const [state, setState] = useState<VoiceInputState>('idle');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const cancelledRef = useRef(false);
  const startingRef = useRef(false);
  // Whether the in-progress stop should auto-send the transcript (vs just fill the box).
  const sendRef = useRef(false);
  // Обрывает попытку распознавания, если композер размонтировали посреди неё.
  const inflightRef = useRef<AbortController | null>(null);

  // Ответ сервера приходит через секунды, а отложенный — через минуты: к этому
  // времени колбэки композера могли смениться, поэтому зовём свежие.
  const { onNotice } = options;
  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);
  const onNoticeRef = useRef(onNotice);
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
    onErrorRef.current = onError;
    onNoticeRef.current = onNotice;
  });

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  // Stop the mic if the component unmounts mid-recording. The recorder is stopped
  // explicitly so its final chunk lands and onstop parks the dictation in the outbox
  // for the next composer instead of dropping it.
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
      startingRef.current = false;
      inflightRef.current?.abort();
      const rec = recorderRef.current;
      if (rec && rec.state !== 'inactive') {
        try {
          rec.stop();
        } catch {
          /* recorder already gone */
        }
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      recorderRef.current = null;
    };
  }, []);

  // Отложенная надиктовка дошла: текст — в поле ввода, но не отправляется сам.
  // За минуты, пока она ждала сеть, человек мог уйти в другой разговор мыслями.
  const deliverFromOutbox = useCallback((text: string, record: VoiceOutboxRecord) => {
    if (cancelledRef.current) return false;
    if (!text) {
      onErrorRef.current?.(t('voice.outbox.noSpeech', { duration: formatVoiceDuration(record.durationMs) }));
      return true;
    }
    onTranscriptRef.current(text, false);
    onNoticeRef.current?.(t('voice.outbox.delivered', { duration: formatVoiceDuration(record.durationMs) }));
    return true;
  }, [t]);

  const outbox = useVoiceOutbox({
    enabled: Boolean(options.outboxEnabled) && state === 'idle',
    owner,
    deliver: deliverFromOutbox,
  });

  const start = useCallback(async () => {
    if (startingRef.current || (recorderRef.current && recorderRef.current.state !== 'inactive')) return;
    // The mic API is absent outside a secure context (HTTPS/localhost). Over plain HTTP
    // to a LAN/Tailscale IP `navigator.mediaDevices` is undefined — fail with a clear
    // message instead of a raw "reading 'getUserMedia' of undefined" crash.
    if (typeof navigator === 'undefined' || typeof navigator.mediaDevices?.getUserMedia !== 'function') {
      onError?.('Microphone needs a secure connection (HTTPS or localhost).');
      return;
    }
    startingRef.current = true;
    // Пока пользователь диктует, TLS-хендшейк и CORS-preflight успевают пройти
    // фоном — иначе их цена ложится на паузу после отпускания кнопки.
    warmUpVoiceBackend();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (cancelledRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      const mimeType = pickMime();
      const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorderRef.current = rec;
      chunksRef.current = [];

      const active: ActiveRecording = {
        id: newRecordingId(),
        owner,
        startedAt: Date.now(),
        type: mimeType || 'audio/webm',
        filename: '',
        seq: 0,
        chain: Promise.resolve(),
        release: () => {},
        persistFailed: false,
      };

      rec.ondataavailable = (e) => {
        if (e.data.size <= 0) return;
        chunksRef.current.push(e.data);
        const seq = active.seq++;
        const data = e.data;
        persist(active, () => getVoiceOutboxStore().appendChunk(active.id, seq, data));
      };

      rec.onstop = async () => {
        stopTracks();
        const durationMs = Date.now() - active.startedAt;
        // Capture and clear the send intent for this stop before any async work.
        const shouldSend = sendRef.current;
        sendRef.current = false;
        const blob = new Blob(chunksRef.current, { type: active.type });
        const store = getVoiceOutboxStore();

        // Хвост дописан и запись закрыта в очереди ДО любой сети: что бы ни
        // случилось дальше, аудио уже на устройстве.
        if (blob.size >= VOICE_MIN_AUDIO_BYTES) {
          persist(active, () => store.update(active.id, { status: 'pending', durationMs }));
        }
        await active.chain;

        try {
          if (blob.size < VOICE_MIN_AUDIO_BYTES) {
            await store.remove(active.id).catch(() => {});
            if (cancelledRef.current) return;
            setState('idle');
            onErrorRef.current?.('Recording too short');
            return;
          }
          // Композер ушёл посреди записи: надиктовка остаётся в очереди и
          // достанется следующему.
          if (cancelledRef.current) {
            await ensurePersisted(active, blob, durationMs);
            return;
          }

          setState('transcribing');
          const controller = new AbortController();
          inflightRef.current = controller;
          const outcome = await transcribeWithRetries(blob, active.filename, {
            idempotencyKey: active.id,
            durationMs,
            signal: controller.signal,
            onRetry: (attempt, total) => {
              if (!cancelledRef.current) onNoticeRef.current?.(t('voice.retrying', { attempt, total }));
            },
          });
          if (inflightRef.current === controller) inflightRef.current = null;

          if (outcome.ok) {
            // Размонтировали, пока ждали ответ, — вручать некому. Запись не
            // трогаем: следующий композер дошлёт её, а сервер узнает повтор по
            // Idempotency-Key и отдаст готовый текст.
            if (cancelledRef.current) return;
            if (outcome.text) onTranscriptRef.current(outcome.text, shouldSend);
            else onErrorRef.current?.('No speech detected');
            await store.remove(active.id).catch(() => {});
            return;
          }
          if (outcome.cancelled) return;

          const kept = await keepInOutbox(active, blob, durationMs, outcome);
          if (cancelledRef.current) return;
          if (!kept) {
            onErrorRef.current?.(`Transcription failed: ${outcome.message}`);
          } else if (!outcome.transient) {
            onErrorRef.current?.(t('voice.outbox.rejected', { error: outcome.message }));
          } else {
            onNoticeRef.current?.(outcome.offline ? t('voice.outbox.savedOffline') : t('voice.outbox.savedRetry'));
          }
        } finally {
          active.release();
          notifyVoiceOutboxChanged();
          if (!cancelledRef.current) setState('idle');
        }
      };

      // timeslice: кодируем Opus ПО ХОДУ записи, а не одним куском на stop().
      // Без аргумента браузер финализирует контейнер только после отпускания
      // кнопки — задержка росла с длиной надиктовки. Замер: нативный клиент шлёт
      // готовый PCM мгновенно, браузер же платил кодированием именно в тот момент,
      // когда пользователь уже ждёт текст.
      rec.start(RECORDER_TIMESLICE_MS);
      active.type = rec.mimeType || active.type;
      active.filename = `recording.${extensionFor(active.type)}`;
      // Запись в очереди появляется уже под замком: другая вкладка не примет
      // идущую диктовку за брошенную.
      persist(active, async () => {
        active.release = await holdVoiceRecordLock(active.id);
        await getVoiceOutboxStore().begin({
          id: active.id,
          owner: active.owner,
          createdAt: active.startedAt,
          mimeType: active.type,
          filename: active.filename,
        });
      });
      setState('recording');
    } catch (e) {
      recorderRef.current = null;
      stopTracks();
      if (cancelledRef.current) return;
      const err = e as { name?: string; message?: string };
      let msg = `Mic error: ${err?.message || e}`;
      if (err?.name === 'NotAllowedError') msg = 'Microphone access denied.';
      else if (err?.name === 'NotFoundError') msg = 'No microphone found.';
      onError?.(msg);
      setState('idle');
    } finally {
      startingRef.current = false;
    }
  }, [onError, owner, t]);

  // Stop recording. Pass { send: true } to auto-send the transcript once it's ready.
  // Guard on the recorder's own state (not React state) so a double tap, or the mic
  // and Send buttons both firing, can't call stop() on an already-inactive recorder.
  const stop = useCallback((opts?: { send?: boolean }) => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      sendRef.current = opts?.send ?? false;
      rec.stop();
    }
  }, []);

  const toggle = useCallback(() => {
    if (state === 'recording') stop();
    else if (state === 'idle') start();
  }, [state, start, stop]);

  return { state, toggle, stop, outbox };
}
