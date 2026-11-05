import { useEffect, useState } from 'react';

import { api } from '@/shared/api';
import type { VoiceConfig } from '@/shared/voiceConfig';
import {
  emitVoiceConfigSync,
  hasStoredVoiceApiKey,
  hydrateVoiceConfig,
  readVoiceConfig,
  setCachedHasVoiceApiKey,
  VOICE_CONFIG_SYNC_EVENT,
  writeVoiceConfigCache,
} from '@/shared/voiceConfig';

/**
 * The settings panel's view of the voice config.
 *
 * Upstream persists this straight to `localStorage`. We keep it server-side
 * instead — see `shared/voiceConfig` — so the endpoint and models survive a
 * cache clear and the apiKey is never written to browser storage at all.
 */
export function useVoiceConfig() {
  const [config, setConfig] = useState<VoiceConfig>(() => readVoiceConfig());
  const [hasApiKey, setHasApiKey] = useState<boolean>(() => hasStoredVoiceApiKey());

  // The settings panel may mount before (or without) a login-time hydration,
  // so make sure the fields show what is actually stored.
  useEffect(() => {
    let cancelled = false;

    const syncFromCache = () => {
      if (cancelled) return;
      setConfig(readVoiceConfig());
      setHasApiKey(hasStoredVoiceApiKey());
    };

    void hydrateVoiceConfig().then(syncFromCache);
    window.addEventListener(VOICE_CONFIG_SYNC_EVENT, syncFromCache);
    return () => {
      cancelled = true;
      window.removeEventListener(VOICE_CONFIG_SYNC_EVENT, syncFromCache);
    };
  }, []);

  /**
   * Applies a patch locally and persists it. Only the changed fields are sent,
   * so an untouched apiKey is never overwritten (and never has to be read back
   * from the server just to save an unrelated field).
   */
  const update = (patch: Partial<VoiceConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...patch };
      writeVoiceConfigCache(next);
      if (typeof patch.apiKey === 'string') {
        const nextHasApiKey = Boolean(patch.apiKey);
        setCachedHasVoiceApiKey(nextHasApiKey);
        setHasApiKey(nextHasApiKey);
      }

      const payload: Record<string, string> = {};
      for (const [key, value] of Object.entries(patch)) {
        if (typeof value === 'string') {
          payload[key] = key === 'ttsFormat' ? value.trim() : value;
        }
      }

      if (Object.keys(payload).length > 0) {
        void api.updateVoiceSettings(payload).catch(() => {
          // Keep the typed value on screen; a later edit retries the write.
        });
      }

      emitVoiceConfigSync();
      return next;
    });
  };

  /**
   * GOLDJAXE fork (реестр §4.16): saves a patch and reports the outcome, for
   * fields whose rejection the user must see (the summary instruction has a
   * length limit). The cache changes only after the server accepted the save.
   */
  const save = async (patch: Partial<VoiceConfig>): Promise<{ ok: boolean; error?: string }> => {
    try {
      const response = await api.updateVoiceSettings(patch);
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        return { ok: false, error: body?.error?.message || `HTTP ${response.status}` };
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    setConfig((prev) => {
      const next = { ...prev, ...patch };
      writeVoiceConfigCache(next);
      emitVoiceConfigSync();
      return next;
    });
    return { ok: true };
  };

  return { config, update, save, hasApiKey };
}
