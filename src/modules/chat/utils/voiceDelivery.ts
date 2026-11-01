/**
 * GOLDJAXE fork (реестр §4.14): доставка надиктовки на распознавание.
 *
 * Политика та же, что у клиента diktor (`client/http.py`, `client/outbox.py`):
 *   • временная беда — обрыв, таймаут, 408/425/429/5xx — не приговор: пара
 *     повторов сразу, а дальше запись ждёт в очереди и уходит фоном;
 *   • отказ, который повтором не лечится (401/403 — ключ, 400/413/422 — сам
 *     запрос), фон не долбит: запись остаётся, решает человек;
 *   • пропала сеть (`offline`) — текущий запрос обрывается сразу, а не висит до
 *     таймаута; вернулась (`online`) — очередь досылается.
 *
 * Каждая попытка несёт `Idempotency-Key` = id записи: если ответ потерялся на
 * обрыве, повтор получает уже готовый результат сервера, а не распознаёт аудио
 * второй раз.
 */
import { transcribeVoice } from '@/shared/api';
import {
  getVoiceOutboxStore,
  hasCrossTabLocks,
  notifyVoiceOutboxChanged,
  withVoiceRecordLock,
  type VoiceOutboxRecord,
  type VoiceOutboxStore,
} from '@/modules/chat/utils/voiceOutbox';

/** Паузы перед повторами сразу после диктовки: 1 с, затем 2.5 с — как в diktor. */
export const VOICE_RETRY_DELAYS_MS = [1000, 2500];
/** Как часто фон пробует дослать очередь. */
export const VOICE_OUTBOX_FLUSH_INTERVAL_MS = 20_000;
/** После стольких неудач запись выпадает из фоновых повторов (кнопка «Отправить» остаётся). */
export const VOICE_OUTBOX_MAX_ATTEMPTS = 20;
/** Дольше неотправленное не храним: это сырое аудио на устройстве. */
export const VOICE_OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Потолок очереди — ~7 часов речи в Opus. Сверх — уходят самые старые. */
export const VOICE_OUTBOX_MAX_BYTES = 100 * 1024 * 1024;
/** Короче этого — дребезг кнопки, текста не выйдет (порог прежнего кода). */
export const VOICE_MIN_AUDIO_BYTES = 800;
/** Без Web Locks запись «recording» считается брошенной, если чанков нет дольше этого. */
export const VOICE_ORPHAN_AFTER_MS = 30_000;

const TIMEOUT_MIN_MS = 60_000;
const TIMEOUT_MAX_MS = 300_000;

/**
 * 408 — сервер не дождался тела, 425 — рано, 429 — троттлинг, 5xx — сервер
 * или прокси перед ним временно не тянет. Остальное повтором не лечится.
 */
export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Сколько ждать ответа. Загрузка и распознавание растут с длиной аудио: на
 * плохом мобильном канале 10 минут речи (~2 МБ) грузятся больше минуты. Повтор
 * после таймаута дешёвый — сервер узнает его по Idempotency-Key, — поэтому
 * потолок держим умеренным, а не «сколько угодно».
 */
export function transcribeTimeoutMs(durationMs: number): number {
  const scaled = 30_000 + Math.max(0, durationMs) * 0.25;
  return Math.round(Math.min(TIMEOUT_MAX_MS, Math.max(TIMEOUT_MIN_MS, scaled)));
}

export type TranscribeOutcome =
  | { ok: true; text: string }
  | {
    ok: false;
    /** Повтор может помочь. */
    transient: boolean;
    /** Сети нет вовсе — повторять до `online` бессмысленно. */
    offline: boolean;
    timedOut: boolean;
    /** Отменили мы сами (размонтирование, кнопка). */
    cancelled: boolean;
    message: string;
    status?: number;
  };

const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    if (!text) return '';
    try {
      const data = JSON.parse(text) as { error?: unknown; detail?: unknown; message?: unknown };
      const detail = data.error ?? data.detail ?? data.message;
      if (typeof detail === 'string') return detail;
      if (detail && typeof detail === 'object' && typeof (detail as { message?: unknown }).message === 'string') {
        return (detail as { message: string }).message;
      }
    } catch {
      /* не JSON — берём как есть */
    }
    return text.slice(0, 200);
  } catch {
    return '';
  }
}

/** Одна попытка распознавания с таймаутом и обрывом по `offline`. */
export async function transcribeOnce(
  blob: Blob,
  filename: string,
  options: { idempotencyKey: string; durationMs: number; signal?: AbortSignal },
): Promise<TranscribeOutcome> {
  if (options.signal?.aborted) {
    return { ok: false, transient: true, offline: false, timedOut: false, cancelled: true, message: 'cancelled' };
  }
  if (isOffline()) {
    return { ok: false, transient: true, offline: true, timedOut: false, cancelled: false, message: 'offline' };
  }

  const controller = new AbortController();
  let reason: 'timeout' | 'offline' | 'cancel' | null = null;
  const abort = (why: 'timeout' | 'offline' | 'cancel') => {
    if (reason) return;
    reason = why;
    controller.abort();
  };
  const timer = setTimeout(() => abort('timeout'), transcribeTimeoutMs(options.durationMs));
  const onOffline = () => abort('offline');
  const onCancel = () => abort('cancel');
  window.addEventListener('offline', onOffline);
  options.signal?.addEventListener('abort', onCancel);

  try {
    const response = await transcribeVoice(blob, filename, {
      signal: controller.signal,
      idempotencyKey: options.idempotencyKey,
    });
    if (!response.ok) {
      const detail = await readErrorDetail(response);
      return {
        ok: false,
        transient: isTransientStatus(response.status),
        offline: false,
        timedOut: false,
        cancelled: false,
        message: `HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
        status: response.status,
      };
    }
    const data = await response.json() as { text?: unknown } | null;
    return { ok: true, text: String(data?.text || '').trim() };
  } catch (error) {
    const why = reason as 'timeout' | 'offline' | 'cancel' | null;
    return {
      ok: false,
      transient: true,
      offline: why === 'offline' || isOffline(),
      timedOut: why === 'timeout',
      cancelled: why === 'cancel',
      message: why === 'timeout'
        ? 'timeout'
        : why === 'offline'
          ? 'offline'
          : error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
    window.removeEventListener('offline', onOffline);
    options.signal?.removeEventListener('abort', onCancel);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      window.removeEventListener('offline', done);
      resolve();
    }
    signal?.addEventListener('abort', done);
    // Сеть пропала во время паузы — дальше ждать нечего, следующая попытка
    // сразу вернёт «offline» и запись уйдёт в очередь.
    window.addEventListener('offline', done);
    if (signal?.aborted) done();
  });
}

/**
 * Попытка сразу после диктовки плюс повторы с паузами. Таймаут, отсутствие
 * сети и отказ без надежды на повтор заканчивают круг сразу: запись уходит в
 * очередь, а человек не смотрит на спиннер лишние минуты.
 */
export async function transcribeWithRetries(
  blob: Blob,
  filename: string,
  options: {
    idempotencyKey: string;
    durationMs: number;
    delays?: number[];
    signal?: AbortSignal;
    onRetry?: (attempt: number, total: number) => void;
  },
): Promise<TranscribeOutcome & { attempts: number }> {
  const delays = options.delays ?? VOICE_RETRY_DELAYS_MS;
  const total = delays.length + 1;
  let outcome: TranscribeOutcome = await transcribeOnce(blob, filename, options);
  let attempts = 1;
  while (!outcome.ok && attempts < total) {
    if (!outcome.transient || outcome.offline || outcome.timedOut || outcome.cancelled) break;
    await sleep(delays[attempts - 1], options.signal);
    attempts += 1;
    options.onRetry?.(attempts, total);
    outcome = await transcribeOnce(blob, filename, options);
  }
  return { ...outcome, attempts };
}

//----------------- ФОНОВЫЙ ДОСЫЛЬЩИК ------------

/**
 * Вручает распознанный текст. `false` — вручать некому (композер размонтирован):
 * запись остаётся в очереди и уйдёт со следующим досыльщиком.
 */
export type VoiceOutboxDeliver = (text: string, record: VoiceOutboxRecord) => boolean;

type FlushOptions = {
  /** Только эта запись — кнопка «Отправить». */
  onlyId?: string;
  /** Отправить и запись, выпавшую из фоновых повторов. */
  force?: boolean;
};

const sendingIds = new Set<string>();

/** Записи, которые досыльщик этой вкладки отправляет прямо сейчас. */
export function getVoiceOutboxSendingIds(): ReadonlySet<string> {
  return sendingIds;
}

let orphanSweepDone = false;

/**
 * Уборка по правилам: просроченные записи, переполнение квоты (старые первыми)
 * и — раз за загрузку страницы — чанки-сироты. Записи, которые сейчас кто-то
 * держит (пишет или отправляет), не трогаются.
 */
async function pruneVoiceOutbox(store: VoiceOutboxStore, now: number): Promise<VoiceOutboxRecord[]> {
  if (!orphanSweepDone) {
    orphanSweepDone = true;
    await store.removeOrphanChunks().catch(() => 0);
  }
  const kept: VoiceOutboxRecord[] = [];
  const records = await store.list();
  let total = records.reduce((sum, record) => sum + record.size, 0);
  for (const record of records) {
    const expired = now - record.createdAt > VOICE_OUTBOX_TTL_MS;
    const overQuota = total > VOICE_OUTBOX_MAX_BYTES;
    if (expired || overQuota) {
      const removed = await withVoiceRecordLock(record.id, () => store.remove(record.id));
      if (removed.acquired) {
        total -= record.size;
        continue;
      }
    }
    kept.push(record);
  }
  return kept;
}

type SendResult = 'sent' | 'skipped' | 'failed' | 'stop';

async function sendStoredRecord(
  store: VoiceOutboxStore,
  id: string,
  deliver: VoiceOutboxDeliver,
): Promise<SendResult> {
  let record = await store.get(id);
  if (!record) return 'skipped';

  if (record.status === 'recording') {
    // Сюда доходит только запись без хозяина: её замок свободен, значит вкладка,
    // которая её писала, умерла посреди диктовки. Без Web Locks хозяина узнаём
    // по свежим чанкам.
    if (!hasCrossTabLocks() && Date.now() - record.updatedAt < VOICE_ORPHAN_AFTER_MS) return 'skipped';
    const durationMs = Math.max(record.durationMs, record.updatedAt - record.createdAt);
    await store.update(id, { status: 'pending', durationMs });
    record = { ...record, status: 'pending', durationMs };
  }

  const audio = await store.readAudio(id);
  if (!audio || audio.size < VOICE_MIN_AUDIO_BYTES) {
    await store.remove(id);
    return 'skipped';
  }

  sendingIds.add(id);
  notifyVoiceOutboxChanged();
  try {
    const outcome = await transcribeOnce(audio, record.filename, {
      idempotencyKey: id,
      durationMs: record.durationMs,
    });
    if (outcome.ok) {
      if (!deliver(outcome.text, record)) return 'stop';
      await store.remove(id);
      return 'sent';
    }
    if (outcome.cancelled) return 'stop';
    const attempts = record.attempts + 1;
    await store.update(id, {
      attempts,
      lastError: outcome.offline ? 'offline' : outcome.message,
      lastAttemptAt: Date.now(),
      permanent: !outcome.transient || attempts >= VOICE_OUTBOX_MAX_ATTEMPTS,
    });
    // Канал лёг — остальные записи упрутся в то же самое, долбить его незачем.
    return outcome.transient ? 'stop' : 'failed';
  } finally {
    sendingIds.delete(id);
  }
}

async function runFlush(deliver: VoiceOutboxDeliver, options: FlushOptions): Promise<void> {
  const store = getVoiceOutboxStore();
  try {
    const records = await pruneVoiceOutbox(store, Date.now());
    for (const record of records) {
      if (options.onlyId && record.id !== options.onlyId) continue;
      if (record.permanent && !options.force) continue;
      if (isOffline()) break;
      const result = await withVoiceRecordLock(record.id, () => sendStoredRecord(store, record.id, deliver));
      if (result.acquired && result.value === 'stop') break;
    }
  } finally {
    notifyVoiceOutboxChanged();
  }
}

let flushing: Promise<void> | null = null;

/**
 * Досылает очередь: от старых записей к новым, до первой сетевой беды. Фоновые
 * вызовы, пока идёт проход, не плодят новых; кнопка «Отправить» встаёт за ним.
 */
export function flushVoiceOutbox(deliver: VoiceOutboxDeliver, options: FlushOptions = {}): Promise<void> {
  if (flushing && !options.onlyId) return flushing;
  const current: Promise<void> = (flushing ?? Promise.resolve())
    .then(() => runFlush(deliver, options))
    .catch((error) => {
      console.warn('[voice-outbox] flush failed:', error);
    })
    .finally(() => {
      if (flushing === current) flushing = null;
    });
  flushing = current;
  return current;
}

/** Сброс состояния модуля между тестами. */
export function resetVoiceDeliveryForTests(): void {
  flushing = null;
  orphanSweepDone = false;
  sendingIds.clear();
}
