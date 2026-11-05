import { voiceSettingsDb } from '@/modules/database/index.js';
import {
  postSmallModelRequest,
  resolveSmallModel,
  resolveSmallModelCredentials,
} from '@/shared/small-model.js';

import { createSpeechSummaryRouter } from './speech-summary.routes.js';
import { createSpeechSummaryService } from './speech-summary.service.js';

const speechSummaryService = createSpeechSummaryService({
  readUserSettings: (userId) => {
    try {
      const voice = voiceSettingsDb.getVoiceSettings(userId);
      return { mode: voice.speechSummary, prompt: voice.speechSummaryPrompt };
    } catch {
      // A storage failure must not take read-aloud down, nor send replies to
      // the model for a user who may have switched summaries off: read in full.
      return { mode: 'off', prompt: '' };
    }
  },
  resolveCredentials: resolveSmallModelCredentials,
  resolveModel: () => resolveSmallModel('CLOUDCLI_SPEECH_SUMMARY_MODEL'),
  request: postSmallModelRequest,
});

/** Read-aloud summary router assembled for the server entrypoint. */
export const speechSummaryRoutes = createSpeechSummaryRouter(speechSummaryService);
