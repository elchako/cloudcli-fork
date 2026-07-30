import { useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import { readVoiceConfig, VOICE_CONFIG_SYNC_EVENT } from '../../../hooks/useVoiceConfig';

// Voice UI is gated on the `voiceEnabled` UI preference (toggled in Quick Settings /
// the Settings modal) and a configured voice backend.
const STORAGE_KEY = 'uiPreferences';
const SYNC_EVENT = 'ui-preferences:sync';
let healthRequest: Promise<boolean> | null = null;

function checkVoiceHealth(): Promise<boolean> {
  if (healthRequest) return healthRequest;
  const request = authenticatedFetch('/api/voice/health')
    .then(async (response) => {
      if (!response.ok) throw new Error(`Voice health check failed (${response.status})`);
      const data = await response.json();
      return data?.configured === true;
    })
    .finally(() => {
      healthRequest = null;
    });
  healthRequest = request;
  return request;
}

function readVoiceEnabled(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return parsed?.voiceEnabled === true || parsed?.voiceEnabled === 'true';
  } catch {
    return false;
  }
}

// The mic API (navigator.mediaDevices.getUserMedia) is only exposed in a secure
// context — HTTPS or localhost. Over plain HTTP to a LAN/Tailscale IP on a phone
// `navigator.mediaDevices` is undefined, so recording would throw on tap. Gate the
// button on it: no capture API → no button (instead of a button that always errors).
function canCaptureMic(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}

export function useVoiceAvailable(): boolean {
  const [enabled, setEnabled] = useState<boolean>(() =>
    typeof window === 'undefined' ? false : readVoiceEnabled(),
  );
  const [available, setAvailable] = useState(false);
  // Capture support is a static property of the browser context; read it once.
  const [micSupported] = useState<boolean>(() =>
    typeof window === 'undefined' ? false : canCaptureMic(),
  );

  useEffect(() => {
    const update = () => setEnabled(readVoiceEnabled());
    window.addEventListener('storage', update);
    window.addEventListener(SYNC_EVENT, update as EventListener);
    return () => {
      window.removeEventListener('storage', update);
      window.removeEventListener(SYNC_EVENT, update as EventListener);
    };
  }, []);

  useEffect(() => {
    let active = true;
    let requestId = 0;

    const check = async () => {
      if (!enabled) {
        setAvailable(false);
        return;
      }
      if (readVoiceConfig().baseUrl.trim()) {
        setAvailable(true);
        return;
      }
      const id = ++requestId;
      try {
        const result = await checkVoiceHealth();
        if (active && id === requestId) setAvailable(result);
      } catch {
        if (active && id === requestId) setAvailable(false);
      }
    };

    void check();
    window.addEventListener(VOICE_CONFIG_SYNC_EVENT, check);
    return () => {
      active = false;
      window.removeEventListener(VOICE_CONFIG_SYNC_EVENT, check);
    };
  }, [enabled]);

  return enabled && available && micSupported;
}
