import { voiceSettingsDb } from '@/modules/database/index.js';
import {
  listSmallModels,
  loadClaudeSettingsEnv,
  postSmallModelRequest,
  resolveSmallModelCredentials,
} from '@/shared/small-model.js';
import { readOptionalString } from '@/shared/utils.js';

import { createSpeechSummaryRouter } from './speech-summary.routes.js';
import { createSpeechSummaryService } from './speech-summary.service.js';

const speechSummaryService = createSpeechSummaryService({
  readUserSettings: (userId) => {
    try {
      const voice = voiceSettingsDb.getVoiceSettings(userId);
      return { mode: voice.speechSummary, prompt: voice.speechSummaryPrompt, model: voice.speechSummaryModel };
    } catch {
      // A storage failure must not take read-aloud down, nor send replies to
      // the model for a user who may have switched summaries off: read in full.
      return { mode: 'off', prompt: '', model: '' };
    }
  },
  resolveCredentials: resolveSmallModelCredentials,
  // The operator's choice; Claude Code's own Haiku alias is deliberately not
  // used here — the summary defaults to Haiku 5.5 (§4.16-бис).
  resolveServerModel: async () => process.env.CLOUDCLI_SPEECH_SUMMARY_MODEL?.trim()
    || readOptionalString((await loadClaudeSettingsEnv()).CLOUDCLI_SPEECH_SUMMARY_MODEL)
    || null,
  request: postSmallModelRequest,
  listModels: (credentials) => listSmallModels(credentials, { timeoutMs: 10_000 }),
});

/** Read-aloud summary router assembled for the server entrypoint. */
export const speechSummaryRoutes = createSpeechSummaryRouter(speechSummaryService);
