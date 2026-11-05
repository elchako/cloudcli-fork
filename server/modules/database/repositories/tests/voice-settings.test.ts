import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

let tempDir: string;

// A fresh on-disk DB per run: set DATABASE_PATH before the connection singleton
// is created, then initialize the schema. The encryption key file is written
// next to the DB, so it lands in the same temp dir and is cleaned up with it.
before(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'voice-settings-test-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  delete process.env.CLOUDCLI_SECRET_KEY;

  const { getConnection } = await import('@/modules/database/connection.js');
  const { initializeDatabase } = await import('@/modules/database/init-db.js');
  await initializeDatabase();

  const db = getConnection();
  db.prepare(
    "INSERT INTO users (id, username, password_hash) VALUES (1, 'tester', 'x')"
  ).run();
  db.prepare(
    "INSERT INTO users (id, username, password_hash) VALUES (2, 'other', 'x')"
  ).run();
  db.prepare(
    "INSERT INTO users (id, username, password_hash) VALUES (3, 'third', 'x')"
  ).run();
});

after(async () => {
  const { closeConnection } = await import('@/modules/database/connection.js');
  closeConnection();
  const { resetSecretKeyCache } = await import('@/shared/secret-box.js');
  resetSecretKeyCache();
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
  delete process.env.DATABASE_PATH;
});

test('getVoiceSettings returns empty fields before anything is stored', async () => {
  const { voiceSettingsDb } = await import('@/modules/database/repositories/voice-settings.js');

  assert.deepEqual(voiceSettingsDb.getVoiceSettings(1), {
    baseUrl: '', sttModel: '', ttsModel: '', ttsVoice: '', ttsFormat: '',
    speechSummary: '', speechSummaryPrompt: '', speechSummaryModel: '', hasApiKey: false,
  });
  assert.equal(voiceSettingsDb.getVoiceApiKey(1), null);
});

test('updateVoiceSettings stores fields and reports the key without exposing it', async () => {
  const { voiceSettingsDb } = await import('@/modules/database/repositories/voice-settings.js');

  const stored = voiceSettingsDb.updateVoiceSettings(1, {
    baseUrl: 'https://api.openai.com/v1',
    sttModel: 'whisper-1',
    ttsModel: 'tts-1',
    ttsVoice: 'alloy',
    ttsFormat: 'mp3',
    apiKey: 'sk-voice-secret',
  });

  assert.equal(stored.baseUrl, 'https://api.openai.com/v1');
  assert.equal(stored.sttModel, 'whisper-1');
  assert.equal(stored.hasApiKey, true);
  // The public view must never carry the secret itself.
  assert.equal((stored as Record<string, unknown>).apiKey, undefined);
  // Server-side reads still get the real value back.
  assert.equal(voiceSettingsDb.getVoiceApiKey(1), 'sk-voice-secret');
});

test('the apiKey is encrypted at rest, not stored as written', async () => {
  const { voiceSettingsDb } = await import('@/modules/database/repositories/voice-settings.js');
  const { getConnection } = await import('@/modules/database/connection.js');

  voiceSettingsDb.updateVoiceSettings(1, { apiKey: 'sk-plaintext-check' });
  const row = getConnection()
    .prepare('SELECT api_key_encrypted FROM voice_settings WHERE user_id = ?')
    .get(1) as { api_key_encrypted: string };

  // This is the whole point of the feature: reading the DB file must not reveal
  // the key.
  assert.ok(!row.api_key_encrypted.includes('sk-plaintext-check'));
  assert.ok(row.api_key_encrypted.startsWith('gcm.v1.'));
  assert.equal(voiceSettingsDb.getVoiceApiKey(1), 'sk-plaintext-check');
});

test('a partial update keeps the stored key and untouched fields', async () => {
  const { voiceSettingsDb } = await import('@/modules/database/repositories/voice-settings.js');

  voiceSettingsDb.updateVoiceSettings(1, {
    baseUrl: 'https://voice.example.test',
    sttModel: 'whisper-1',
    apiKey: 'sk-keep-me',
  });

  // Saving one unrelated field must not wipe the secret — the settings panel
  // writes field-by-field as the user types.
  const updated = voiceSettingsDb.updateVoiceSettings(1, { ttsVoice: 'nova' });

  assert.equal(updated.ttsVoice, 'nova');
  assert.equal(updated.baseUrl, 'https://voice.example.test');
  assert.equal(updated.sttModel, 'whisper-1');
  assert.equal(updated.hasApiKey, true);
  assert.equal(voiceSettingsDb.getVoiceApiKey(1), 'sk-keep-me');
});

test('an empty apiKey clears the stored key', async () => {
  const { voiceSettingsDb } = await import('@/modules/database/repositories/voice-settings.js');

  voiceSettingsDb.updateVoiceSettings(1, { apiKey: 'sk-to-be-removed' });
  const cleared = voiceSettingsDb.updateVoiceSettings(1, { apiKey: '' });

  assert.equal(cleared.hasApiKey, false);
  assert.equal(voiceSettingsDb.getVoiceApiKey(1), null);
});

test('settings are per-user and do not leak across accounts', async () => {
  const { voiceSettingsDb } = await import('@/modules/database/repositories/voice-settings.js');

  voiceSettingsDb.updateVoiceSettings(2, { baseUrl: 'https://second.example.test', apiKey: 'sk-second' });

  assert.equal(voiceSettingsDb.getVoiceApiKey(2), 'sk-second');
  assert.notEqual(voiceSettingsDb.getVoiceSettings(1).baseUrl, 'https://second.example.test');
});

test('whitespace-only values are normalized away rather than stored', async () => {
  const { voiceSettingsDb } = await import('@/modules/database/repositories/voice-settings.js');

  const stored = voiceSettingsDb.updateVoiceSettings(2, {
    ttsFormat: '  mp3  ',
    ttsVoice: '   ',
    apiKey: '   ',
  });

  assert.equal(stored.ttsFormat, 'mp3');
  assert.equal(stored.ttsVoice, '');
  // A key of only spaces is not a key.
  assert.equal(stored.hasApiKey, false);
});

// GOLDJAXE fork (реестр §4.16): read-aloud summary settings.

test('summary mode and instruction are stored, and a partial save keeps them', async () => {
  const { voiceSettingsDb } = await import('@/modules/database/repositories/voice-settings.js');

  const prompt = 'Перескажи на «вы».\n"Кавычки" и \\ слэш';
  const stored = voiceSettingsDb.updateVoiceSettings(2, { speechSummary: 'off', speechSummaryPrompt: `  ${prompt}  ` });
  assert.equal(stored.speechSummary, 'off');
  assert.equal(stored.speechSummaryPrompt, prompt);

  // An older tab saving only the voice must not reset the summary settings.
  const afterVoice = voiceSettingsDb.updateVoiceSettings(2, { ttsVoice: 'ru-RU-SvetlanaNeural' });
  assert.equal(afterVoice.speechSummary, 'off');
  assert.equal(afterVoice.speechSummaryPrompt, prompt);

  // '' returns both to the defaults.
  const reset = voiceSettingsDb.updateVoiceSettings(2, { speechSummary: '', speechSummaryPrompt: '' });
  assert.equal(reset.speechSummary, '');
  assert.equal(reset.speechSummaryPrompt, '');
  assert.equal(voiceSettingsDb.getVoiceSettings(2).ttsVoice, 'ru-RU-SvetlanaNeural');
});

test('a bad summary mode or an over-long instruction is refused, not clipped', async () => {
  const { voiceSettingsDb, SPEECH_SUMMARY_PROMPT_MAX_CHARS } = await import(
    '@/modules/database/repositories/voice-settings.js'
  );

  voiceSettingsDb.updateVoiceSettings(2, { speechSummary: 'on', speechSummaryPrompt: 'Коротко.' });
  assert.throws(
    () => voiceSettingsDb.updateVoiceSettings(2, { speechSummary: 'always', ttsVoice: 'x' }),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 400,
  );
  assert.throws(
    () => voiceSettingsDb.updateVoiceSettings(2, {
      speechSummaryPrompt: 'я'.repeat(SPEECH_SUMMARY_PROMPT_MAX_CHARS + 1),
    }),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 400,
  );
  // A refused save changes nothing, including the other fields it carried.
  const kept = voiceSettingsDb.getVoiceSettings(2);
  assert.equal(kept.speechSummary, 'on');
  assert.equal(kept.speechSummaryPrompt, 'Коротко.');
  assert.notEqual(kept.ttsVoice, 'x');
  // Exactly at the limit is fine.
  const atLimit = voiceSettingsDb.updateVoiceSettings(2, {
    speechSummaryPrompt: 'я'.repeat(SPEECH_SUMMARY_PROMPT_MAX_CHARS),
  });
  assert.equal(atLimit.speechSummaryPrompt.length, SPEECH_SUMMARY_PROMPT_MAX_CHARS);
});

// GOLDJAXE fork (реестр §4.16-бис): the summary model.

test('the summary model is stored, kept by other saves and checked for format only', async () => {
  const { voiceSettingsDb } = await import('@/modules/database/repositories/voice-settings.js');

  const stored = voiceSettingsDb.updateVoiceSettings(3, { speechSummaryModel: '  claude-haiku-4-5-20251001 ' });
  assert.equal(stored.speechSummaryModel, 'claude-haiku-4-5-20251001');
  // A gateway's own spelling passes: the list may be briefly unavailable.
  assert.equal(
    voiceSettingsDb.updateVoiceSettings(3, { speechSummaryModel: 'anthropic/claude-opus-5-5@2026[1m]' }).speechSummaryModel,
    'anthropic/claude-opus-5-5@2026[1m]',
  );
  assert.equal(
    voiceSettingsDb.updateVoiceSettings(3, { speechSummaryPrompt: 'Коротко.' }).speechSummaryModel,
    'anthropic/claude-opus-5-5@2026[1m]',
  );

  for (const bad of ['claude haiku', 'модель', 'a'.repeat(201), 'x;DROP', '<script>']) {
    assert.throws(
      () => voiceSettingsDb.updateVoiceSettings(3, { speechSummaryModel: bad }),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 400,
      bad,
    );
  }
  assert.equal(voiceSettingsDb.getVoiceSettings(3).speechSummaryModel, 'anthropic/claude-opus-5-5@2026[1m]');
  assert.equal(voiceSettingsDb.updateVoiceSettings(3, { speechSummaryModel: 'a'.repeat(200) }).speechSummaryModel.length, 200);

  // '' returns to the server's choice.
  assert.equal(voiceSettingsDb.updateVoiceSettings(3, { speechSummaryModel: '' }).speechSummaryModel, '');
});
