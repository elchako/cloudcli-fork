import { authenticatedFetch } from '../utils/api';
import { readVoiceConfig, revealVoiceApiKey, voiceConfigHeaders } from '../hooks/useVoiceConfig';

function directUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

export function voiceConfigSignature(): string {
  // The apiKey is excluded on purpose: it is now fetched lazily, so including
  // it would change the signature partway through a session and needlessly
  // invalidate cached audio for a configuration that did not actually change.
  const { apiKey: _apiKey, ...rest } = readVoiceConfig();
  return JSON.stringify(rest);
}

export async function transcribeVoice(blob: Blob, filename: string): Promise<Response> {
  const config = readVoiceConfig();
  const body = new FormData();

  if (config.baseUrl.trim()) {
    // Custom backend: the browser calls it directly (the server proxy ignores
    // client-supplied URLs), so this request needs the raw key in hand.
    const apiKey = config.apiKey || await revealVoiceApiKey();
    body.append('file', blob, filename);
    body.append('model', config.sttModel || 'whisper-1');
    return fetch(directUrl(config.baseUrl.trim(), '/audio/transcriptions'), {
      method: 'POST',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      body,
    });
  }

  // Proxy path: the server attaches the stored (encrypted) key itself, so the
  // browser does not need to hold one.
  body.append('audio', blob, filename);
  return authenticatedFetch('/api/voice/transcribe', {
    method: 'POST',
    headers: voiceConfigHeaders(),
    body,
  });
}

export async function synthesizeVoice(text: string, signal: AbortSignal): Promise<Response> {
  const config = readVoiceConfig();

  if (config.baseUrl.trim()) {
    const apiKey = config.apiKey || await revealVoiceApiKey();
    return fetch(directUrl(config.baseUrl.trim(), '/audio/speech'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.ttsModel || 'tts-1',
        voice: config.ttsVoice || 'alloy',
        input: text,
        ...(config.ttsFormat.trim() ? { response_format: config.ttsFormat.trim() } : {}),
      }),
      signal,
    });
  }

  return authenticatedFetch('/api/voice/tts', {
    method: 'POST',
    body: JSON.stringify({ text }),
    headers: voiceConfigHeaders(),
    signal,
  });
}
