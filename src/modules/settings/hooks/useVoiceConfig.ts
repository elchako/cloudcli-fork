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

  return { config, update, hasApiKey };
}
