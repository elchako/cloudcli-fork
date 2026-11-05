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
import { AppError } from '@/shared/utils.js';
import { openSecret, sealSecret } from '@/shared/secret-box.js';

/**
 * GOLDJAXE fork (реестр §4.16): read-aloud summary settings live next to the
 * rest of the voice config. `speechSummary` is '' (default, on), 'on' or 'off';
 * `speechSummaryPrompt` is the user's own instruction, '' for the built-in one;
 * `speechSummaryModel` (§4.16-бис) is the user's own model, '' for the server's.
 */
export const SPEECH_SUMMARY_MODES = ['', 'on', 'off'] as const;
export type SpeechSummaryMode = (typeof SPEECH_SUMMARY_MODES)[number];
/** An instruction is a system prompt, not a document. */
export const SPEECH_SUMMARY_PROMPT_MAX_CHARS = 8000;
/** A model id as Anthropic and gateways spell it (§4.16-бис); '' = server default. */
const SPEECH_SUMMARY_MODEL_PATTERN = /^[A-Za-z0-9._:/@\[\]-]{1,200}$/;

/** Non-secret fields, safe to send to the browser. */
export type VoiceSettingsPublic = {
  baseUrl: string;
  sttModel: string;
  ttsModel: string;
  ttsVoice: string;
  ttsFormat: string;
  speechSummary: SpeechSummaryMode;
  speechSummaryPrompt: string;
  speechSummaryModel: string;
  hasApiKey: boolean;
};

/** What a client may send us. `apiKey: null` explicitly clears the stored key. */
export type VoiceSettingsInput = {
  baseUrl?: unknown;
  sttModel?: unknown;
  ttsModel?: unknown;
  ttsVoice?: unknown;
  ttsFormat?: unknown;
  speechSummary?: unknown;
  speechSummaryPrompt?: unknown;
  speechSummaryModel?: unknown;
  apiKey?: unknown;
};

type VoiceSettingsRow = {
  base_url: string | null;
  stt_model: string | null;
  tts_model: string | null;
  tts_voice: string | null;
  tts_format: string | null;
  api_key_encrypted: string | null;
  speech_summary: string | null;
  speech_summary_prompt: string | null;
  speech_summary_model: string | null;
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
  speechSummary: '',
  speechSummaryPrompt: '',
  speechSummaryModel: '',
  hasApiKey: false,
};

/** Trims a client-supplied string field, or returns undefined when absent. */
function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return value.trim().slice(0, MAX_FIELD_LENGTH);
}

function readSpeechSummaryMode(value: string | null | undefined): SpeechSummaryMode {
  return (SPEECH_SUMMARY_MODES as readonly string[]).includes(value ?? '') ? (value ?? '') as SpeechSummaryMode : '';
}

/**
 * Validates the summary fields. Unlike the short text fields above they are
 * not silently clipped: a mode outside the list or an instruction over the
 * limit is a client error, and losing the tail of a prompt unnoticed would be
 * worse than refusing it. Omitted (non-string) → keep what is stored.
 */
function normalizeSpeechSummary(input: VoiceSettingsInput): {
  mode?: SpeechSummaryMode;
  prompt?: string;
  model?: string;
} {
  const out: { mode?: SpeechSummaryMode; prompt?: string; model?: string } = {};
  if (typeof input.speechSummary === 'string') {
    const mode = input.speechSummary.trim();
    if (!(SPEECH_SUMMARY_MODES as readonly string[]).includes(mode)) {
      throw new AppError('speechSummary must be "", "on" or "off"', {
        code: 'VOICE_SPEECH_SUMMARY_INVALID',
        statusCode: 400,
      });
    }
    out.mode = mode as SpeechSummaryMode;
  }
  if (typeof input.speechSummaryPrompt === 'string') {
    const prompt = input.speechSummaryPrompt.trim();
    if (prompt.length > SPEECH_SUMMARY_PROMPT_MAX_CHARS) {
      throw new AppError(`The summary instruction is longer than ${SPEECH_SUMMARY_PROMPT_MAX_CHARS} characters`, {
        code: 'VOICE_SPEECH_SUMMARY_PROMPT_TOO_LONG',
        statusCode: 400,
      });
    }
    out.prompt = prompt;
  }
  if (typeof input.speechSummaryModel === 'string') {
    const model = input.speechSummaryModel.trim();
    // Format only: the list of models may be briefly empty, and the user picks
    // from their own endpoint anyway.
    if (model && !SPEECH_SUMMARY_MODEL_PATTERN.test(model)) {
      throw new AppError('speechSummaryModel is not a model id', {
        code: 'VOICE_SPEECH_SUMMARY_MODEL_INVALID',
        statusCode: 400,
      });
    }
    out.model = model;
  }
  return out;
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
    speechSummary: readSpeechSummaryMode(row.speech_summary),
    speechSummaryPrompt: row.speech_summary_prompt ?? '',
    speechSummaryModel: row.speech_summary_model ?? '',
    hasApiKey: Boolean(row.api_key_encrypted),
  };
}

function selectRow(userId: number): VoiceSettingsRow | undefined {
  const db = getConnection();
  return db
    .prepare(
      `SELECT base_url, stt_model, tts_model, tts_voice, tts_format, api_key_encrypted,
              speech_summary, speech_summary_prompt, speech_summary_model
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
    // Validated before the transaction: a bad field rejects the whole save.
    const summary = normalizeSpeechSummary(input);

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
        speech_summary: existing?.speech_summary ?? null,
        speech_summary_prompt: existing?.speech_summary_prompt ?? null,
        speech_summary_model: existing?.speech_summary_model ?? null,
      };

      if (summary.mode !== undefined) {
        next.speech_summary = summary.mode || null;
      }
      if (summary.prompt !== undefined) {
        next.speech_summary_prompt = summary.prompt || null;
      }
      if (summary.model !== undefined) {
        next.speech_summary_model = summary.model || null;
      }

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
           (user_id, base_url, stt_model, tts_model, tts_voice, tts_format, api_key_encrypted,
            speech_summary, speech_summary_prompt, speech_summary_model, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id) DO UPDATE SET
           base_url = excluded.base_url,
           stt_model = excluded.stt_model,
           tts_model = excluded.tts_model,
           tts_voice = excluded.tts_voice,
           tts_format = excluded.tts_format,
           api_key_encrypted = excluded.api_key_encrypted,
           speech_summary = excluded.speech_summary,
           speech_summary_prompt = excluded.speech_summary_prompt,
           speech_summary_model = excluded.speech_summary_model,
           updated_at = CURRENT_TIMESTAMP`,
      ).run(
        userId,
        next.base_url,
        next.stt_model,
        next.tts_model,
        next.tts_voice,
        next.tts_format,
        next.api_key_encrypted,
        next.speech_summary,
        next.speech_summary_prompt,
        next.speech_summary_model,
      );

      return rowToPublic(next);
    });

    return apply();
  },
};
