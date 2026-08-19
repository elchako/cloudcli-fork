import assert from 'node:assert/strict';
import test from 'node:test';

import { createSettingsService } from '../settings.service.js';

type Dependencies = Parameters<typeof createSettingsService>[0];

function dependencies(overrides: Partial<Dependencies> = {}): Dependencies {
  return {
    apiKeys: { list: () => [], create: () => ({}), remove: () => false, toggle: () => false },
    credentials: { list: () => [], create: () => ({}), remove: () => false, toggle: () => false },
    notifications: {
      getPreferences: () => undefined,
      updatePreferences: () => ({}),
      createEnabledEvent: () => ({}),
      notifyUser: () => undefined,
    },
    pushSubscriptions: { save: () => undefined, remove: () => undefined },
    userSettings: { get: () => ({}), update: () => ({}) },
    voiceSettings: { get: () => ({}), getApiKey: () => null, update: () => ({}) },
    getVapidPublicKey: () => null,
    ...overrides,
  };
}

test('listApiKeys redacts secret values through the service boundary', () => {
  const service = createSettingsService(dependencies({
    apiKeys: {
      list: () => [{ id: 1, api_key: '1234567890-secret' }],
      create: () => ({}), remove: () => false, toggle: () => false,
    },
  }));
  assert.equal(service.listApiKeys(1).apiKeys[0]?.api_key, '1234567890...');
});

test('subscribeToPush persists the subscription and enables Web Push', () => {
  const operations: string[] = [];
  const service = createSettingsService(dependencies({
    pushSubscriptions: {
      save: (_id, endpoint) => operations.push(`save:${endpoint}`),
      remove: () => undefined,
    },
    notifications: {
      getPreferences: () => ({ channels: { webPush: false } }),
      updatePreferences: () => { operations.push('preferences'); return {}; },
      createEnabledEvent: () => ({ code: 'push.enabled' }),
      notifyUser: () => { operations.push('notify'); },
    },
  }));

  service.subscribeToPush(1, {
    endpoint: 'https://push.example.test',
    keys: { p256dh: 'key', auth: 'auth' },
  });
  assert.deepEqual(operations, ['save:https://push.example.test', 'preferences', 'notify']);
});

test('updateUserSettings forwards the merge flag to the repository', () => {
  const calls: Array<{ id: number; settings: unknown; merge: boolean }> = [];
  const service = createSettingsService(dependencies({
    userSettings: {
      get: () => ({ theme: 'dark' }),
      update: (id, settings, merge) => { calls.push({ id, settings, merge }); return settings; },
    },
  }));

  const partial = service.updateUserSettings(1, { model: 'kimi-k3[1m]' }, true);
  assert.equal(partial.success, true);
  assert.deepEqual(calls[0], { id: 1, settings: { model: 'kimi-k3[1m]' }, merge: true });

  service.updateUserSettings(2, { theme: 'light' }, false);
  assert.equal(calls[1]?.merge, false);
});

test('getVoiceSettings withholds the apiKey unless it is explicitly requested', () => {
  let apiKeyReads = 0;
  const service = createSettingsService(dependencies({
    voiceSettings: {
      get: () => ({ baseUrl: 'https://voice.example.test', hasApiKey: true }),
      getApiKey: () => { apiKeyReads += 1; return 'sk-secret'; },
      update: () => ({}),
    },
  }));

  // Default read: the browser learns a key exists but never sees it, and the
  // repository is not even asked to decrypt it.
  const hidden = service.getVoiceSettings(1);
  assert.equal((hidden.voice as Record<string, unknown>).apiKey, undefined);
  assert.equal((hidden.voice as Record<string, unknown>).hasApiKey, true);
  assert.equal(apiKeyReads, 0);

  // Opt-in read: needed because a custom backend is called by the browser
  // directly and cannot authenticate without the raw key.
  const revealed = service.getVoiceSettings(1, true);
  assert.equal((revealed.voice as Record<string, unknown>).apiKey, 'sk-secret');
  assert.equal(apiKeyReads, 1);
});

test('updateVoiceSettings rejects non-object payloads instead of forwarding them', () => {
  const received: unknown[] = [];
  const service = createSettingsService(dependencies({
    voiceSettings: {
      get: () => ({}),
      getApiKey: () => null,
      update: (_id, input) => { received.push(input); return input; },
    },
  }));

  service.updateVoiceSettings(1, { sttModel: 'whisper-1' });
  service.updateVoiceSettings(1, 'not-an-object');
  service.updateVoiceSettings(1, null);

  assert.deepEqual(received, [{ sttModel: 'whisper-1' }, {}, {}]);
});
