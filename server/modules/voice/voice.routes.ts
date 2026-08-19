import { Readable } from 'node:stream';

import express from 'express';

import type { VoiceRequestOverrides, VoiceService, VoiceServiceResult } from '@/shared/types.js';
import { asyncHandler } from '@/shared/utils.js';

/** Per-user voice settings persisted server-side; absent in route unit tests. */
type StoredVoiceSettings = {
  getSettings(userId: number): {
    sttModel: string;
    ttsModel: string;
    ttsVoice: string;
    ttsFormat: string;
  };
  getApiKey(userId: number): string | null;
};

type VoiceRouterDependencies = {
  voiceService: VoiceService;
  parseAudioUpload: express.RequestHandler;
  storedVoiceSettings?: StoredVoiceSettings;
};

type AuthenticatedRequest = express.Request & { user?: { id?: number | string } };

function readHeaderValue(value: string | string[] | undefined): string | undefined {
  const normalizedValue = Array.isArray(value) ? value[0] : value;
  const trimmedValue = normalizedValue?.trim();
  return trimmedValue || undefined;
}

/**
 * Builds the per-request overrides.
 *
 * Request headers win, and whatever they omit is filled from the user's stored
 * settings. That ordering matters: the apiKey is deliberately never sent to the
 * browser, so on a fresh device the header is absent and the stored key is the
 * only way the request can authenticate. A client that still holds a local key
 * (or is mid-edit in the settings panel) keeps overriding it as before.
 */
function parseVoiceOverrides(
  request: express.Request,
  storedVoiceSettings?: StoredVoiceSettings,
): VoiceRequestOverrides {
  const fromHeaders: VoiceRequestOverrides = {
    apiKey: readHeaderValue(request.headers['x-voice-api-key']),
    sttModel: readHeaderValue(request.headers['x-voice-stt-model']),
    ttsModel: readHeaderValue(request.headers['x-voice-tts-model']),
    ttsVoice: readHeaderValue(request.headers['x-voice-tts-voice']),
    ttsFormat: readHeaderValue(request.headers['x-voice-tts-format']),
  };

  const userId = Number((request as AuthenticatedRequest).user?.id);
  if (!storedVoiceSettings || !Number.isInteger(userId) || userId <= 0) {
    return fromHeaders;
  }

  try {
    const stored = storedVoiceSettings.getSettings(userId);
    return {
      apiKey: fromHeaders.apiKey ?? storedVoiceSettings.getApiKey(userId) ?? undefined,
      sttModel: fromHeaders.sttModel ?? (stored.sttModel || undefined),
      ttsModel: fromHeaders.ttsModel ?? (stored.ttsModel || undefined),
      ttsVoice: fromHeaders.ttsVoice ?? (stored.ttsVoice || undefined),
      ttsFormat: fromHeaders.ttsFormat ?? (stored.ttsFormat || undefined),
    };
  } catch {
    // A storage failure must not take voice down: fall back to env defaults.
    return fromHeaders;
  }
}

function sendFailure<TValue>(
  response: express.Response,
  result: VoiceServiceResult<TValue>,
): result is Extract<VoiceServiceResult<TValue>, { ok: false }> {
  if (result.ok) {
    return false;
  }

  response.status(result.status).json({ error: result.error });
  return true;
}

/**
 * Creates the transport-only router used by the Voice composition root. It is
 * exported for Voice route tests; other modules consume only the composed
 * router exposed from the Voice barrel.
 */
export function createVoiceRouter(dependencies: VoiceRouterDependencies): express.Router {
  const router = express.Router();

  router.get('/health', (_request, response) => {
    response.json(dependencies.voiceService.getHealth());
  });

  router.post('/transcribe', (request, response, next) => {
    dependencies.parseAudioUpload(request, response, (uploadError?: unknown) => {
      if (uploadError) {
        const message = uploadError instanceof Error ? uploadError.message : String(uploadError);
        response.status(400).json({ error: message });
        return;
      }

      // Multer uses a callback API, so bridge its parsed request into the async
      // service call and forward unexpected rejections to Express middleware.
      void (async () => {
        if (!request.file) {
          response.status(400).json({ error: 'No audio uploaded' });
          return;
        }

        const result = await dependencies.voiceService.transcribe({
          audio: {
            bytes: request.file.buffer,
            mimeType: request.file.mimetype || 'audio/webm',
            fileName: request.file.originalname || 'recording.webm',
          },
          overrides: parseVoiceOverrides(request, dependencies.storedVoiceSettings),
        });

        if (sendFailure(response, result)) {
          return;
        }

        response.json(result.value);
      })().catch(next);
    });
  });

  router.post('/tts', asyncHandler(async (request, response) => {
    const text = request.body?.text;
    if (typeof text !== 'string' || !text.trim()) {
      response.status(400).json({ error: 'text required' });
      return;
    }

    const result = await dependencies.voiceService.synthesizeSpeech({
      text,
      overrides: parseVoiceOverrides(request, dependencies.storedVoiceSettings),
    });
    if (sendFailure(response, result)) {
      return;
    }

    response.setHeader('Content-Type', result.value.contentType);
    response.setHeader('Cache-Control', 'no-store');
    if (!result.value.body) {
      response.end();
      return;
    }

    Readable.fromWeb(result.value.body).on('error', (error) => response.destroy(error)).pipe(response);
  }));

  return router;
}
