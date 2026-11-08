import { api } from '@/shared/api';
import { readVoiceConfig } from '@/shared/voiceConfig';

/**
 * GOLDJAXE fork (реестр §4.16): decides what read-aloud speaks — a short
 * summary of the reply or the reply itself.
 *
 * In `shared/` because two modules use it: the chat player asks it what to
 * speak, the settings tab reads the server status from it.
 *
 * The summary is made by the CloudCLI server with the user's own model access
 * (`/api/speech-summary`); the voice backend only receives the finished text.
 * It is an improvement, never a dependency: switched off, unavailable, a short
 * reply, an old server without the route, a slow or failing model — all end
 * with the full reply being read.
 */

export type SpeechSummaryStatus = {
  available: boolean;
  enabled: boolean;
  model: string;
  /** §4.16-бис; absent from a server before it. */
  defaultModel?: string;
  fallbackModel?: string;
  defaultPrompt: string;
  minChars: number;
};

let statusPromise: Promise<SpeechSummaryStatus | null> | null = null;

/** Server capabilities, fetched once per page load (and again after a failure). */
export function loadSpeechSummaryStatus(): Promise<SpeechSummaryStatus | null> {
  if (!statusPromise) {
    statusPromise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await api.speechSummary.status({ signal: controller.signal });
        // An older server answers this path with the app's index.html.
        if (!response.ok || !(response.headers.get('content-type') || '').includes('application/json')) {
          return null;
        }
        return await response.json() as SpeechSummaryStatus;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    })();
    void statusPromise.then((status) => {
      if (!status) statusPromise = null;
    });
  }
  return statusPromise;
}

export type SpeechSummaryModel = { id: string; label: string; catalogProvider?: string };
export type SpeechSummaryModels = {
  models: SpeechSummaryModel[] | null;
  source?: 'api' | 'api-cache' | 'fallback';
};

/** GOLDJAXE fork (реестр §4.16-тер): полный текстовый API-каталог, ID не меняются.
 * Старые серверы отдают только IDs; недоступность не равна пустому каталогу. */
export async function loadSpeechSummaryModels(force = false): Promise<SpeechSummaryModels> {
  try {
    const response = await api.speechSummary.models(force);
    if (!response.ok || !(response.headers.get('content-type') || '').includes('application/json')) {
      return { models: null };
    }
    const body = await response.json() as { models?: unknown; modelOptions?: unknown; source?: unknown };
    const raw = 'modelOptions' in body ? body.modelOptions : body.models;
    const models = Array.isArray(raw) ? raw.flatMap((item): SpeechSummaryModel[] => {
      if (typeof item === 'string') return [{ id: item, label: item }];
      if (!item || typeof item !== 'object' || typeof item.id !== 'string') return [];
      return [{ id: item.id, label: typeof item.label === 'string' ? item.label : item.id,
        ...(typeof item.catalogProvider === 'string' ? { catalogProvider: item.catalogProvider } : {}) }];
    }) : null;
    const source = body.source === 'api' || body.source === 'api-cache' || body.source === 'fallback' ? body.source : undefined;
    return { models, ...(source ? { source } : {}) };
  } catch {
    return { models: null };
  }
}

/** For tests: forget the cached server status. */
export function resetSpeechSummaryStatusForTests(): void {
  statusPromise = null;
}

/**
 * GOLDJAXE fork (реестр §4.16-тер): только пользовательская отмена запрещает чтение.
 * Таймаут/ошибки оставляют исходный ПОЛНЫЙ текст, а уведомление не является
 * ошибкой TTS и в текст синтеза не подмешивается.
 */
export async function prepareSpokenText(
  content: string, signal: AbortSignal, onFullText?: () => void,
): Promise<string> {
  const cancelled = () => new DOMException('Read-aloud stopped', 'AbortError');
  if (signal.aborted) throw cancelled();
  if (readVoiceConfig().speechSummary === 'off' || content.trim().length < 700) return content;

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      controller.abort();
      reject(cancelled());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    // Серверная цепочка ограничена 30 с. Запас — на /status и сеть, не на ещё
    // один проход моделей. Даже зависший/старый сервер не блокирует TTS надолго.
    timer = setTimeout(() => {
      controller.abort();
      reject(new DOMException('Summary timed out', 'TimeoutError'));
    }, 35_000);
  });
  const prepare = async (): Promise<{ text: string; fallback: boolean }> => {
    const status = await loadSpeechSummaryStatus();
    if (controller.signal.aborted) throw cancelled();
    if (!status?.available) return { text: content, fallback: true };
    if (content.trim().length < status.minChars) return { text: content, fallback: false };
    // status.enabled кэшируется: локальный выключатель актуальнее. Сервер тоже
    // заново читает настройку и при off не запускает ни основную, ни резерв.
    const response = await api.speechSummary.summarize(content, { signal: controller.signal });
    if (!response.ok) return { text: content, fallback: true };
    const body = await response.json() as { summary?: unknown; reason?: string };
    return typeof body.summary === 'string' && body.summary.trim()
      ? { text: body.summary, fallback: false }
      : { text: content, fallback: body.reason !== 'disabled' && body.reason !== 'short' };
  };
  try {
    const result = await Promise.race([prepare(), stopped]);
    if (signal.aborted) throw cancelled();
    if (result.fallback) onFullText?.();
    return result.text;
  } catch {
    if (signal.aborted) throw cancelled();
    onFullText?.();
    return content;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    controller.abort();
  }
}
