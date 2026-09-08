import assert from 'node:assert/strict';

import { beforeEach, test } from 'vitest';

import {
  readVoiceConfig,
  resetVoiceConfigCache,
  seedVoiceConfigCacheForTests,
  VOICE_CONFIG_DEFAULTS,
  voiceConfigHeaders,
} from '@/shared/voiceConfig';

/**
 * voiceConfigHeaders decides what leaves the browser: it attaches the user's
 * own API key to the voice proxy request. An empty field must be omitted rather
 * than sent blank, because the server falls back to its env defaults only for
 * headers that are absent — sending `x-voice-api-key: ''` would authenticate
 * every user's transcription against nothing.
 */

// Fork: the config lives on the server and is held in a memory cache, so a
// test seeds that cache rather than localStorage — the apiKey is deliberately
// never written to browser storage. The header rules asserted below are
// upstream's, unchanged.
const write = (config: Record<string, unknown>) => {
  seedVoiceConfigCacheForTests(config);
};

beforeEach(() => {
  localStorage.clear();
  resetVoiceConfigCache();
});

test('no stored config sends no headers at all', () => {
  assert.deepEqual(voiceConfigHeaders(), {});
});

test('an empty api key is omitted, not sent blank', () => {
  write({ apiKey: '', sttModel: 'whisper-1' });

  const headers = voiceConfigHeaders();
  assert.equal('x-voice-api-key' in headers, false);
  assert.equal(headers['x-voice-stt-model'], 'whisper-1');
});

test('each configured field maps to its own header', () => {
  write({
    apiKey: 'sk-test',
    sttModel: 'whisper-1',
    ttsModel: 'tts-1',
    ttsVoice: 'alloy',
    ttsFormat: 'mp3',
  });

  assert.deepEqual(voiceConfigHeaders(), {
    'x-voice-api-key': 'sk-test',
    'x-voice-stt-model': 'whisper-1',
    'x-voice-tts-model': 'tts-1',
    'x-voice-tts-voice': 'alloy',
    'x-voice-tts-format': 'mp3',
  });
});

test('baseUrl is never sent as a header', () => {
  // It is the client's own target, not something the proxy is told to trust.
  write({ baseUrl: 'https://example.test', apiKey: 'sk-test' });

  assert.deepEqual(Object.keys(voiceConfigHeaders()), ['x-voice-api-key']);
});

test('a whitespace-only tts format is treated as unset', () => {
  write({ ttsFormat: '   ' });

  assert.deepEqual(voiceConfigHeaders(), {});
});

test('a padded tts format is trimmed before being sent', () => {
  write({ ttsFormat: '  mp3  ' });

  assert.equal(voiceConfigHeaders()['x-voice-tts-format'], 'mp3');
});

test('a non-string field is discarded rather than coerced into a header', () => {
  write({ apiKey: 12345, sttModel: 'whisper-1' });

  assert.deepEqual(voiceConfigHeaders(), { 'x-voice-stt-model': 'whisper-1' });
});

test('an unhydrated cache falls back to the defaults instead of throwing', () => {
  // This runs on the request path; a throw here would break voice input rather
  // than degrade it to the server's own configuration. Before hydration (or
  // after a logout reset) the cache holds the defaults and sends no headers.
  resetVoiceConfigCache();

  assert.deepEqual(readVoiceConfig(), VOICE_CONFIG_DEFAULTS);
  assert.deepEqual(voiceConfigHeaders(), {});
});

test('an array is not treated as a config object', () => {
  // Same guard as upstream's, applied where the shape is now read from: the
  // seed path coerces per known key, so a list contributes no fields at all.
  seedVoiceConfigCacheForTests(['apiKey'] as unknown as Record<string, unknown>);

  assert.deepEqual(readVoiceConfig(), VOICE_CONFIG_DEFAULTS);
});

test('each read returns its own object, so a caller cannot mutate the defaults', () => {
  const first = readVoiceConfig();
  first.apiKey = 'leaked';

  assert.equal(readVoiceConfig().apiKey, '');
  assert.equal(VOICE_CONFIG_DEFAULTS.apiKey, '');
});
