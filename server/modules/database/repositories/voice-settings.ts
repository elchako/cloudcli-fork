/**
 * Per-user voice (STT/TTS) settings repository.
 *
 * The voice panel used to keep everything — endpoint, models, voice, format and
 * the apiKey — in `localStorage` only, so clearing the browser cache wiped the
 * whole configuration. The non-secret fields could have gone into the shared
 * user-settings blob, but the apiKey could not: that blob is deliberately
 * secret-free (see `user-settings.ts`). Keeping the config in one row instead
 * of splitting it across two stores means the settings can never half-restore.
 *
 * The apiKey is sealed with AES-256-GCM (`server/shared/secret-box.ts`) before
 * it is written and is never returned to the client — callers get
 * `hasApiKey` and the server attaches the real value when proxying voice
 * requests.
 */

import { getConnection } from '@/modules/database/connection.js';
import { openSecret, sealSecret } from '@/shared/secret-box.js';

/** Non-secret fields, safe to send to the browser. */
export type VoiceSettingsPublic = {
  baseUrl: string;
  sttModel: string;
  ttsModel: string;
  ttsVoice: string;
  ttsFormat: string;
  hasApiKey: boolean;
};

/** What a client may send us. `apiKey: null` explicitly clears the stored key. */
export type VoiceSettingsInput = {
  baseUrl?: unknown;
  sttModel?: unknown;
  ttsModel?: unknown;
  ttsVoice?: unknown;
  ttsFormat?: unknown;
  apiKey?: unknown;
};

type VoiceSettingsRow = {
  base_url: string | null;
  stt_model: string | null;
  tts_model: string | null;
  tts_voice: string | null;
  tts_format: string | null;
  api_key_encrypted: string | null;
};

const TEXT_FIELDS = ['baseUrl', 'sttModel', 'ttsModel', 'ttsVoice', 'ttsFormat'] as const;
type TextField = (typeof TEXT_FIELDS)[number];

const COLUMN_BY_FIELD: Record<TextField, keyof VoiceSettingsRow> = {
  baseUrl: 'base_url',
  sttModel: 'stt_model',
  ttsModel: 'tts_model',
  ttsVoice: 'tts_voice',
  ttsFormat: 'tts_format',
};

// A URL, model name or voice id is short; anything longer is a mistake or abuse
// and would bloat the row for no benefit.
const MAX_FIELD_LENGTH = 2048;

const EMPTY_PUBLIC: VoiceSettingsPublic = {
  baseUrl: '',
  sttModel: '',
  ttsModel: '',
  ttsVoice: '',
  ttsFormat: '',
  hasApiKey: false,
};

/** Trims a client-supplied string field, or returns undefined when absent. */
function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return value.trim().slice(0, MAX_FIELD_LENGTH);
}

function rowToPublic(row: VoiceSettingsRow | undefined): VoiceSettingsPublic {
  if (!row) {
    return { ...EMPTY_PUBLIC };
  }

  return {
    baseUrl: row.base_url ?? '',
    sttModel: row.stt_model ?? '',
    ttsModel: row.tts_model ?? '',
    ttsVoice: row.tts_voice ?? '',
    ttsFormat: row.tts_format ?? '',
    hasApiKey: Boolean(row.api_key_encrypted),
  };
}

function selectRow(userId: number): VoiceSettingsRow | undefined {
  const db = getConnection();
  return db
    .prepare(
      `SELECT base_url, stt_model, tts_model, tts_voice, tts_format, api_key_encrypted
       FROM voice_settings WHERE user_id = ?`,
    )
    .get(userId) as VoiceSettingsRow | undefined;
}

export const voiceSettingsDb = {
  /** Returns the user's voice settings without the secret. */
  getVoiceSettings(userId: number): VoiceSettingsPublic {
    return rowToPublic(selectRow(userId));
  },

  /**
   * Returns the decrypted apiKey, or null when none is stored (or when it
   * cannot be opened, e.g. the key file was replaced). Server-side only.
   */
  getVoiceApiKey(userId: number): string | null {
    const row = selectRow(userId);
    if (!row?.api_key_encrypted) {
      return null;
    }
    return openSecret(row.api_key_encrypted);
  },

  /**
   * Merges the supplied fields into the stored row and returns the public view.
   *
   * Field semantics, chosen so a partial save cannot silently erase the key:
   *   - omitted (`undefined`) → keep what is stored;
   *   - `apiKey: ''` or `null` → clear the stored key;
   *   - any other string → seal and replace it.
   */
  updateVoiceSettings(userId: number, input: VoiceSettingsInput): VoiceSettingsPublic {
    const db = getConnection();

    // Read-modify-write must be atomic: two concurrent saves that each read the
    // same base would otherwise let the later one drop the earlier one's fields.
    const apply = db.transaction((): VoiceSettingsPublic => {
      const existing = selectRow(userId);

      const next: VoiceSettingsRow = {
        base_url: existing?.base_url ?? null,
        stt_model: existing?.stt_model ?? null,
        tts_model: existing?.tts_model ?? null,
        tts_voice: existing?.tts_voice ?? null,
        tts_format: existing?.tts_format ?? null,
        api_key_encrypted: existing?.api_key_encrypted ?? null,
      };

      for (const field of TEXT_FIELDS) {
        const value = normalizeText(input[field]);
        if (value !== undefined) {
          next[COLUMN_BY_FIELD[field]] = value || null;
        }
      }

      if (input.apiKey === null || input.apiKey === '') {
        next.api_key_encrypted = null;
      } else if (typeof input.apiKey === 'string') {
        const trimmed = input.apiKey.trim();
        next.api_key_encrypted = trimmed ? sealSecret(trimmed) : null;
      }

      db.prepare(
        `INSERT INTO voice_settings
           (user_id, base_url, stt_model, tts_model, tts_voice, tts_format, api_key_encrypted, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id) DO UPDATE SET
           base_url = excluded.base_url,
           stt_model = excluded.stt_model,
           tts_model = excluded.tts_model,
           tts_voice = excluded.tts_voice,
           tts_format = excluded.tts_format,
           api_key_encrypted = excluded.api_key_encrypted,
           updated_at = CURRENT_TIMESTAMP`,
      ).run(
        userId,
        next.base_url,
        next.stt_model,
        next.tts_model,
        next.tts_voice,
        next.tts_format,
        next.api_key_encrypted,
      );

      return rowToPublic(next);
    });

    return apply();
  },
};
