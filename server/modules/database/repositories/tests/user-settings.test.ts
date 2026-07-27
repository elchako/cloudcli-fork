import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

let tempDir: string;

// A fresh on-disk DB per run: set DATABASE_PATH before the connection singleton
// is created, then initialize the schema.
before(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'user-settings-test-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');

  const { getConnection } = await import('@/modules/database/connection.js');
  const { initializeDatabase } = await import('@/modules/database/init-db.js');
  await initializeDatabase();

  // A user row is required because user_settings.user_id references users(id).
  const db = getConnection();
  db.prepare(
    "INSERT INTO users (id, username, password_hash) VALUES (1, 'tester', 'x')"
  ).run();
});

after(async () => {
  const { closeConnection } = await import('@/modules/database/connection.js');
  closeConnection();
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
  delete process.env.DATABASE_PATH;
});

test('getUserSettings returns an empty object before anything is stored', async () => {
  const { userSettingsDb } = await import('@/modules/database/repositories/user-settings.js');
  assert.deepEqual(userSettingsDb.getSettings(1), {});
});

test('updateUserSettings stores and returns settings', async () => {
  const { userSettingsDb } = await import('@/modules/database/repositories/user-settings.js');
  const stored = userSettingsDb.updateSettings(1, {
    userLanguage: 'ru',
    theme: 'dark',
    'claude-effort': 'high',
  });
  assert.equal(stored.userLanguage, 'ru');
  assert.equal(stored.theme, 'dark');
  assert.equal(stored['claude-effort'], 'high');

  // Persisted across reads.
  assert.deepEqual(userSettingsDb.getSettings(1), stored);
});

test('updateUserSettings merges partial updates by default', async () => {
  const { userSettingsDb } = await import('@/modules/database/repositories/user-settings.js');
  userSettingsDb.updateSettings(1, { userLanguage: 'en' });
  const merged = userSettingsDb.getSettings(1);
  // Changed key updated, others preserved.
  assert.equal(merged.userLanguage, 'en');
  assert.equal(merged.theme, 'dark');
  assert.equal(merged['claude-effort'], 'high');
});

test('updateUserSettings with merge=false replaces the whole blob', async () => {
  const { userSettingsDb } = await import('@/modules/database/repositories/user-settings.js');
  const replaced = userSettingsDb.updateSettings(1, { theme: 'light' }, false);
  assert.deepEqual(replaced, { theme: 'light' });
  assert.equal(userSettingsDb.getSettings(1).userLanguage, undefined);
});

test('updateUserSettings strips forbidden secret keys', async () => {
  const { userSettingsDb } = await import('@/modules/database/repositories/user-settings.js');
  const stored = userSettingsDb.updateSettings(1, {
    theme: 'dark',
    apiKey: 'sk-should-not-persist',
    voiceApiKey: 'sk-also-not',
  }, false);
  assert.equal(stored.theme, 'dark');
  assert.equal(stored.apiKey, undefined);
  assert.equal(stored.voiceApiKey, undefined);
});

test('updateUserSettings rejects non-object payloads to an empty blob', async () => {
  const { userSettingsDb } = await import('@/modules/database/repositories/user-settings.js');
  assert.deepEqual(userSettingsDb.updateSettings(1, 'nope', false), {});
  assert.deepEqual(userSettingsDb.updateSettings(1, [1, 2, 3], false), {});
});

test('oversized blob evicts only the largest key, not everything', async () => {
  const { userSettingsDb } = await import('@/modules/database/repositories/user-settings.js');
  const huge = 'x'.repeat(70 * 1024); // > 64KB cap on its own
  const stored = userSettingsDb.updateSettings(1, {
    userLanguage: 'ru',
    theme: 'dark',
    bloated: huge,
  }, false);
  // The bloated key is dropped; the small, valid settings survive.
  assert.equal(stored.bloated, undefined);
  assert.equal(stored.userLanguage, 'ru');
  assert.equal(stored.theme, 'dark');
});

test('merge preserves existing keys not present in the update (atomic RMW)', async () => {
  const { userSettingsDb } = await import('@/modules/database/repositories/user-settings.js');
  userSettingsDb.updateSettings(1, { a: '1', b: '2', c: '3' }, false);
  const merged = userSettingsDb.updateSettings(1, { b: 'updated' }, true);
  assert.equal(merged.a, '1');
  assert.equal(merged.b, 'updated');
  assert.equal(merged.c, '3');
});
