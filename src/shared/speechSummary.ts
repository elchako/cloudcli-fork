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
  defaultPrompt: string;
  minChars: number;
};

let statusPromise: Promise<SpeechSummaryStatus | null> | null = null;

/** Server capabilities, fetched once per page load (and again after a failure). */
export function loadSpeechSummaryStatus(): Promise<SpeechSummaryStatus | null> {
  if (!statusPromise) {
    statusPromise = (async () => {
      try {
        const response = await api.speechSummary.status();
        // An older server answers this path with the app's index.html.
        if (!response.ok || !(response.headers.get('content-type') || '').includes('application/json')) {
          return null;
        }
        return await response.json() as SpeechSummaryStatus;
      } catch {
        return null;
      }
    })();
    void statusPromise.then((status) => {
      if (!status) statusPromise = null;
    });
  }
  return statusPromise;
}

/**
 * GOLDJAXE fork (реестр §4.16-бис): Claude models the user's endpoint offers,
 * for the settings picker. Empty on any failure — the picker then offers the
 * default and the current choice only.
 */
export async function loadSpeechSummaryModels(): Promise<string[]> {
  try {
    const response = await api.speechSummary.models();
    if (!response.ok || !(response.headers.get('content-type') || '').includes('application/json')) {
      return [];
    }
    const body = await response.json() as { models?: unknown };
    return Array.isArray(body.models) ? body.models.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** For tests: forget the cached server status. */
export function resetSpeechSummaryStatusForTests(): void {
  statusPromise = null;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * The text read-aloud should speak. Rejects only with an AbortError (the user
 * pressed «Стоп» while the summary was being made); everything else resolves
 * to the summary or, failing that, to the reply as it is.
 */
export async function prepareSpokenText(content: string, signal: AbortSignal): Promise<string> {
  if (readVoiceConfig().speechSummary === 'off') {
    return content;
  }
  const status = await loadSpeechSummaryStatus();
  if (signal.aborted) {
    throw new DOMException('Read-aloud stopped', 'AbortError');
  }
  // The user's switch is the local config read above, not `status.enabled`:
  // the status is cached for the page's life and would keep a switch flipped
  // in the settings since then. The server answers null for 'off' anyway.
  if (!status?.available || content.trim().length < status.minChars) {
    return content;
  }

  try {
    const response = await api.speechSummary.summarize(content, { signal });
    if (!response.ok) {
      return content;
    }
    const body = await response.json() as { summary?: unknown };
    return typeof body.summary === 'string' && body.summary.trim() ? body.summary : content;
  } catch (error) {
    if (isAbort(error) || signal.aborted) {
      throw error;
    }
    return content;
  }
}
