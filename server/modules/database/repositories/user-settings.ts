/**
 * User settings repository.
 *
 * Stores per-user UI/composer settings (language, theme, selected provider &
 * model, reasoning effort, editor prefs, UI toggles, …) as one JSON blob so
 * they survive cache clears, relogin and origin/port changes and follow the
 * user across devices. Modelled on notification-preferences.
 *
 * This blob is for non-secret preferences only. Secrets (e.g. the voice STT/TTS
 * apiKey) must NOT be written here — they belong in user_credentials, which the
 * settings GET route never returns to the client.
 */

import { getConnection } from '@/modules/database/connection.js';

export type UserSettings = Record<string, unknown>;

const EMPTY_SETTINGS: UserSettings = {};

// Guard against oversized or malformed blobs. Settings are small key/value
// preferences; anything larger is almost certainly wrong (or abuse) and would
// bloat the row, so we cap the serialized size.
const MAX_SETTINGS_BYTES = 64 * 1024; // 64KB

// Keys that must never be persisted server-side even if the client sends them.
// The voice apiKey is a secret and lives in user_credentials instead.
const FORBIDDEN_KEYS = new Set(['voiceApiKey', 'apiKey']);

/**
 * Accepts an arbitrary client-supplied settings object and returns a safe,
 * JSON-serializable plain object. Non-objects become empty; forbidden secret
 * keys are stripped; values are kept only when JSON-serializable; the whole
 * blob is dropped to empty if it exceeds the size cap.
 */
function normalizeUserSettings(value: unknown): UserSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...EMPTY_SETTINGS };
  }

  const result: UserSettings = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) {
      continue;
    }
    // Keep only values that round-trip through JSON (primitives, plain
    // objects/arrays). Functions/undefined/symbols are dropped by JSON anyway.
    try {
      const serialized = JSON.stringify(entry);
      if (serialized === undefined) {
        continue;
      }
      result[key] = JSON.parse(serialized);
    } catch {
      // Skip values that cannot be serialized (e.g. circular structures).
    }
  }

  const serializedAll = JSON.stringify(result);
  if (serializedAll.length > MAX_SETTINGS_BYTES) {
    return { ...EMPTY_SETTINGS };
  }

  return result;
}

export const userSettingsDb = {
  /** Returns the stored settings for a user, or an empty object on first read. */
  getUserSettings(userId: number): UserSettings {
    const db = getConnection();
    const row = db
      .prepare('SELECT settings_json FROM user_settings WHERE user_id = ?')
      .get(userId) as { settings_json: string } | undefined;

    if (!row) {
      return { ...EMPTY_SETTINGS };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.settings_json);
    } catch {
      parsed = EMPTY_SETTINGS;
    }
    return normalizeUserSettings(parsed);
  },

  /**
   * Upserts settings for a user and returns the stored value. When `merge` is
   * true the incoming keys are merged over the existing blob (partial update);
   * otherwise the blob is replaced.
   */
  updateUserSettings(userId: number, settings: unknown, merge = true): UserSettings {
    const db = getConnection();

    const incoming = normalizeUserSettings(settings);
    const next = merge
      ? normalizeUserSettings({ ...userSettingsDb.getUserSettings(userId), ...incoming })
      : incoming;

    db.prepare(
      `INSERT INTO user_settings (user_id, settings_json, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET
         settings_json = excluded.settings_json,
         updated_at = CURRENT_TIMESTAMP`
    ).run(userId, JSON.stringify(next));

    return next;
  },

  // Convenience aliases matching the route naming.
  getSettings(userId: number): UserSettings {
    return userSettingsDb.getUserSettings(userId);
  },
  updateSettings(userId: number, settings: unknown, merge = true): UserSettings {
    return userSettingsDb.updateUserSettings(userId, settings, merge);
  },
};
