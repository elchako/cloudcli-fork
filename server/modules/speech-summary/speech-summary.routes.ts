import express from 'express';

import { asyncHandler } from '@/shared/utils.js';

import type { SpeechSummaryService } from './speech-summary.service.js';

type AuthenticatedRequest = express.Request & { user?: { id?: number | string } };

function requestUserId(request: express.Request): number {
  return Number((request as AuthenticatedRequest).user?.id);
}

/**
 * GOLDJAXE fork (реестр §4.16): HTTP surface of the read-aloud summary.
 *
 *   GET  /status → what the settings screen needs (no secrets);
 *   POST /       → { summary: string | null, reason? }.
 *
 * Every outcome except an oversized body is a 200 with `summary: null` and a
 * reason: the client then reads the reply in full. A busy server answers 429
 * the same way.
 */
export function createSpeechSummaryRouter(service: SpeechSummaryService): express.Router {
  const router = express.Router();

  router.get('/status', asyncHandler(async (request, response) => {
    response.json(await service.getStatus(requestUserId(request)));
  }));

  router.post('/', asyncHandler(async (request, response) => {
    // «Стоп» in the browser drops the connection: stop paying for the summary
    // too. `res` close fires on a finished response as well, hence the check.
    const controller = new AbortController();
    response.on('close', () => {
      if (!response.writableFinished) controller.abort();
    });

    const result = await service.summarize(requestUserId(request), request.body?.text, controller.signal);
    if (controller.signal.aborted) {
      return;
    }

    switch (result.status) {
      case 'ok':
        response.json({ summary: result.summary });
        return;
      case 'too-long':
        response.status(413).json({ summary: null, reason: 'too-long' });
        return;
      case 'busy':
        response.status(429).json({ summary: null, reason: 'busy' });
        return;
      default:
        response.json({ summary: null, reason: result.reason });
    }
  }));

  return router;
}
