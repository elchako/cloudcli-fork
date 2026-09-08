/**
 * Voice (STT/TTS) configuration, persisted per-user on the server.
 *
 * This used to live in `localStorage` only, so clearing the browser cache lost
 * the endpoint, models and apiKey. Now the non-secret fields round-trip through
 * `/api/settings/voice-settings` and the apiKey is stored encrypted server-side
 * (AES-256-GCM) and never returned — reads report only `hasApiKey`.
 *
 * Two consumers force the shape of this module:
 *   - `shared/api` reads the config synchronously while building a request, so
 *     a memory cache is hydrated once after login and kept in sync on save;
 *   - when `baseUrl` is set the browser calls that backend DIRECTLY (the server
 *     proxy deliberately ignores client URLs to avoid becoming an SSRF hop), so
 *     the raw key must be present in memory for those calls. It is fetched
 *     explicitly via `revealVoiceApiKey` and kept in memory only — never
 *     written back to localStorage, which is what leaked it across cache
 *     clears in the first place.
 *
 * Upstream keeps this file as a plain localStorage reader; the exported names
 * are preserved so `shared/api` and the settings hook import it unchanged.
 */

// `shared/api` imports this module back for its voice request headers. The
// cycle is safe because every `api` call below happens inside an async function,
// long after both modules have finished evaluating.
import { api } from '@/shared/api';

export type VoiceConfig = {
  baseUrl: string;
  apiKey: string;
  sttModel: string;
  ttsModel: string;
  ttsVoice: string;
  ttsFormat: string;
};

/**
 * Legacy client-side store. Read once to migrate an existing setup up to the
 * server, then cleared so the apiKey stops sitting in browser storage.
 */
export const VOICE_CONFIG_STORAGE_KEY = 'voiceConfig';

/** Emitted on write, so open voice consumers re-read in the same tab. */
export const VOICE_CONFIG_SYNC_EVENT = 'voice-config:sync';

export const VOICE_CONFIG_DEFAULTS: VoiceConfig = {
  baseUrl: '',
  apiKey: '',
  sttModel: '',
  ttsModel: '',
  ttsVoice: '',
  ttsFormat: '',
};

// Synchronous view used by the request builders in `shared/api`. `apiKey` is
// filled only after `revealVoiceApiKey()` resolves; an empty string means "let
// the server attach the stored key", which is exactly what the proxy path does.
let cachedConfig: VoiceConfig = { ...VOICE_CONFIG_DEFAULTS };
let cachedHasApiKey = false;
let hydrationPromise: Promise<void> | null = null;

export function emitVoiceConfigSync(): void {
  try {
    window.dispatchEvent(new Event(VOICE_CONFIG_SYNC_EVENT));
  } catch {
    // Non-DOM environment — nothing listens anyway.
  }
}

/** Reads the legacy localStorage blob, or null when absent/unparseable. */
function readLegacyConfig(): VoiceConfig | null {
  try {
    const raw = localStorage.getItem(VOICE_CONFIG_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const config = { ...VOICE_CONFIG_DEFAULTS };
    for (const key of Object.keys(VOICE_CONFIG_DEFAULTS) as (keyof VoiceConfig)[]) {
      if (typeof parsed[key] === 'string') config[key] = parsed[key];
    }
    return config;
  } catch {
    return null;
  }
}

function applyServerVoice(voice: Record<string, unknown> | null | undefined): void {
  if (!voice || typeof voice !== 'object') return;

  const readString = (key: string): string =>
    typeof voice[key] === 'string' ? voice[key] as string : '';

  cachedHasApiKey = Boolean(voice.hasApiKey);
  cachedConfig = {
    ...cachedConfig,
    baseUrl: readString('baseUrl'),
    sttModel: readString('sttModel'),
    ttsModel: readString('ttsModel'),
    ttsVoice: readString('ttsVoice'),
    ttsFormat: readString('ttsFormat'),
  };
}

/**
 * Loads the stored config into the memory cache. Idempotent and safe to call on
 * every login; the in-flight promise is shared so concurrent callers issue one
 * request. On first run it migrates a legacy localStorage config up to the
 * server (apiKey included) and then removes it locally.
 */
export function hydrateVoiceConfig(): Promise<void> {
  if (hydrationPromise) {
    return hydrationPromise;
  }

  hydrationPromise = (async () => {
    try {
      const response = await api.getVoiceSettings();
      if (!response.ok) return;

      const data = await response.json();
      applyServerVoice(data?.voice);

      const legacy = readLegacyConfig();
      const serverIsEmpty = !cachedConfig.baseUrl
        && !cachedConfig.sttModel && !cachedConfig.ttsModel
        && !cachedConfig.ttsVoice && !cachedConfig.ttsFormat && !cachedHasApiKey;

      if (legacy && serverIsEmpty) {
        // One-time migration: push the local setup up, then stop keeping the
        // secret in browser storage.
        await api.updateVoiceSettings(legacy);
        cachedConfig = { ...legacy, apiKey: '' };
        cachedHasApiKey = Boolean(legacy.apiKey);
      }

      if (legacy) {
        try { localStorage.removeItem(VOICE_CONFIG_STORAGE_KEY); } catch { /* ignore */ }
      }

      emitVoiceConfigSync();
    } catch {
      // Offline or server error — voice falls back to server env defaults.
    } finally {
      // Allow a later retry if this attempt produced nothing usable.
      if (!cachedConfig.baseUrl && !cachedHasApiKey) {
        hydrationPromise = null;
      }
    }
  })();

  return hydrationPromise;
}

/** Drops cached state on logout so the next user cannot inherit it. */
export function resetVoiceConfigCache(): void {
  cachedConfig = { ...VOICE_CONFIG_DEFAULTS };
  cachedHasApiKey = false;
  hydrationPromise = null;
}

/**
 * Synchronous snapshot for request builders. `apiKey` is populated only when
 * `revealVoiceApiKey()` has run — direct-to-backend calls need it, proxied
 * calls do not.
 */
export function readVoiceConfig(): VoiceConfig {
  return { ...cachedConfig };
}

/** Replaces the cached config; used by the settings hook on every edit. */
export function writeVoiceConfigCache(next: VoiceConfig): void {
  cachedConfig = next;
}

/**
 * Seeds the cache from a partial config, coercing exactly as a server read
 * would: non-string fields are discarded rather than stringified.
 *
 * Exists for tests. Upstream's suite writes localStorage and reads it back,
 * which no longer describes this module — the config is fetched from the
 * server and the apiKey never touches browser storage.
 */
export function seedVoiceConfigCacheForTests(partial: Record<string, unknown>): void {
  const config = { ...VOICE_CONFIG_DEFAULTS };
  for (const key of Object.keys(VOICE_CONFIG_DEFAULTS) as (keyof VoiceConfig)[]) {
    if (typeof partial[key] === 'string') config[key] = partial[key] as string;
  }
  cachedConfig = config;
  cachedHasApiKey = Boolean(config.apiKey);
}

/** Records whether the server holds a key, without holding the key itself. */
export function setCachedHasVoiceApiKey(hasApiKey: boolean): void {
  cachedHasApiKey = hasApiKey;
}

/** True when the server holds a key, even if this browser has not fetched it. */
export function hasStoredVoiceApiKey(): boolean {
  return cachedHasApiKey || Boolean(cachedConfig.apiKey);
}

/**
 * Fetches the raw apiKey for direct-to-backend calls and caches it in memory.
 * Only needed when `baseUrl` is set: the proxy path lets the server attach the
 * key itself, so the browser never has to hold it.
 */
export async function revealVoiceApiKey(): Promise<string> {
  if (cachedConfig.apiKey) {
    return cachedConfig.apiKey;
  }
  if (!cachedHasApiKey) {
    return '';
  }

  try {
    const response = await api.getVoiceSettings({ revealApiKey: true });
    if (!response.ok) return '';
    const data = await response.json();
    const apiKey = typeof data?.voice?.apiKey === 'string' ? data.voice.apiKey : '';
    cachedConfig = { ...cachedConfig, apiKey };
    return apiKey;
  } catch {
    return '';
  }
}

/**
 * Headers the voice proxy reads to target a per-user backend. The apiKey header
 * is sent only when this browser happens to hold the key; otherwise the server
 * falls back to the stored (encrypted) one. Empty fields are omitted so the
 * server's env defaults still apply.
 */
export function voiceConfigHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const c = readVoiceConfig();
  const h: Record<string, string> = {};
  if (c.apiKey) h['x-voice-api-key'] = c.apiKey;
  if (c.sttModel) h['x-voice-stt-model'] = c.sttModel;
  if (c.ttsModel) h['x-voice-tts-model'] = c.ttsModel;
  if (c.ttsVoice) h['x-voice-tts-voice'] = c.ttsVoice;
  if (c.ttsFormat.trim()) h['x-voice-tts-format'] = c.ttsFormat.trim();
  return h;
}
