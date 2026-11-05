import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/shared/api';
import { hydrateVoiceConfig, readVoiceConfig, resetVoiceConfigCache, VOICE_CONFIG_STORAGE_KEY } from '@/shared/voiceConfig';

// GOLDJAXE fork (реестр §4.16-бис): the one-time move of a browser-stored voice
// setup to the server must not wipe the summary settings stored there.

vi.mock('@/shared/api', () => ({
  api: { getVoiceSettings: vi.fn(), updateVoiceSettings: vi.fn() },
}));

const getVoiceSettings = vi.mocked(api.getVoiceSettings);
const updateVoiceSettings = vi.mocked(api.updateVoiceSettings);

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  resetVoiceConfigCache();
  localStorage.clear();
  getVoiceSettings.mockReset();
  updateVoiceSettings.mockReset();
  updateVoiceSettings.mockImplementation(async () => json({ success: true }));
});

describe('hydrateVoiceConfig legacy migration', () => {
  it('moves the voice setup up and leaves the summary settings alone', async () => {
    localStorage.setItem(VOICE_CONFIG_STORAGE_KEY, JSON.stringify({ baseUrl: 'https://voice.test/v1', ttsVoice: 'nova', apiKey: 'k' }));
    getVoiceSettings.mockImplementation(async () => json({
      voice: { speechSummary: 'off', speechSummaryPrompt: 'Своя.', speechSummaryModel: 'claude-sonnet-5-5', hasApiKey: false },
    }));

    await hydrateVoiceConfig();

    const sent = updateVoiceSettings.mock.calls[0][0] as Record<string, unknown>;
    expect(sent).toMatchObject({ baseUrl: 'https://voice.test/v1', ttsVoice: 'nova', apiKey: 'k' });
    expect(sent).not.toHaveProperty('speechSummary');
    expect(sent).not.toHaveProperty('speechSummaryPrompt');
    expect(sent).not.toHaveProperty('speechSummaryModel');
    expect(readVoiceConfig()).toMatchObject({
      baseUrl: 'https://voice.test/v1',
      apiKey: '',
      speechSummary: 'off',
      speechSummaryPrompt: 'Своя.',
      speechSummaryModel: 'claude-sonnet-5-5',
    });
    expect(localStorage.getItem(VOICE_CONFIG_STORAGE_KEY)).toBeNull();
  });
});
