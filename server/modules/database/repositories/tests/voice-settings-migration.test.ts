import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// GOLDJAXE fork (реестр §4.16): an install upgraded from before the read-aloud
// summary has a voice_settings table without its two columns. The migration
// must add them and the existing row must read as the defaults.

let tempDir = '';

after(async () => {
  const { closeConnection } = await import('@/modules/database/connection.js');
  closeConnection();
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
  delete process.env.DATABASE_PATH;
});

test('the migration adds the summary columns to an existing voice_settings table', async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'voice-settings-migration-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  delete process.env.CLOUDCLI_SECRET_KEY;
  const { initializeDatabase } = await import('@/modules/database/init-db.js');
  const { getConnection: connect } = await import('@/modules/database/connection.js');
  await initializeDatabase();

  // Turn the table back into its pre-§4.16 shape, with a stored row.
  const db = connect();
  db.exec('ALTER TABLE voice_settings DROP COLUMN speech_summary');
  db.exec('ALTER TABLE voice_settings DROP COLUMN speech_summary_prompt');
  db.exec('ALTER TABLE voice_settings DROP COLUMN speech_summary_model');
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'tester', 'x')").run();
  db.prepare("INSERT INTO voice_settings (user_id, base_url, tts_voice) VALUES (1, 'https://voice.example.test/v1', 'nova')").run();

  // Starting the server again runs the migrations over that table.
  await initializeDatabase();

  const { getConnection } = await import('@/modules/database/connection.js');
  const columns = (getConnection().prepare('PRAGMA table_info(voice_settings)').all() as { name: string }[])
    .map((column) => column.name);
  assert.ok(columns.includes('speech_summary'));
  assert.ok(columns.includes('speech_summary_prompt'));
  assert.ok(columns.includes('speech_summary_model'));

  const { voiceSettingsDb } = await import('@/modules/database/repositories/voice-settings.js');
  const stored = voiceSettingsDb.getVoiceSettings(1);
  assert.equal(stored.baseUrl, 'https://voice.example.test/v1');
  assert.equal(stored.ttsVoice, 'nova');
  assert.equal(stored.speechSummary, '');
  assert.equal(stored.speechSummaryPrompt, '');
  assert.equal(stored.speechSummaryModel, '');
});
