import { voiceSettingsDb } from '@/modules/database/index.js';
import { claudeApiModelCatalog } from '@/modules/providers/index.js';
import {
  loadClaudeSettingsEnv,
  postSmallModelRequest,
  resolveSmallModelCredentials,
} from '@/shared/small-model.js';
import { readOptionalString } from '@/shared/utils.js';

import { createSpeechSummaryRouter } from './speech-summary.routes.js';
import { createSpeechSummaryService } from './speech-summary.service.js';

const speechSummaryService = createSpeechSummaryService({
  readUserSettings: (userId) => {
    const voice = voiceSettingsDb.getVoiceSettings(userId);
    return {
      mode: voice.speechSummary, prompt: voice.speechSummaryPrompt,
      model: voice.speechSummaryModel, fallbackModel: voice.speechSummaryFallbackModel,
    };
  },
  resolveCredentials: resolveSmallModelCredentials,
  // The operator's choice; Claude Code's own Haiku alias is deliberately not
  // used here — the summary defaults to Haiku 5.5 (§4.16-бис).
  resolveServerModel: async () => process.env.CLOUDCLI_SPEECH_SUMMARY_MODEL?.trim()
    || readOptionalString((await loadClaudeSettingsEnv()).CLOUDCLI_SPEECH_SUMMARY_MODEL)
    || null,
  request: postSmallModelRequest,
  getCatalog: (force) => claudeApiModelCatalog.get(force),
});

/** Read-aloud summary router assembled for the server entrypoint. */
export const speechSummaryRoutes = createSpeechSummaryRouter(speechSummaryService);
