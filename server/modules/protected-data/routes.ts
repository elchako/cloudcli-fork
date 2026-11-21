import { Router, json, type ErrorRequestHandler, type Request } from 'express';

import { sessionsDb } from '@/modules/database/index.js';

import { PROTECTED_DATA_MAX_BODY_BYTES, readProtectedDataEnvelope } from './protocol.js';
import { protectedDataRelay } from './relay.js';

export const protectedDataRoutes = Router();

protectedDataRoutes.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

protectedDataRoutes.get('/', async (_req, res) => {
  const profile = await protectedDataRelay.getProfile();
  if (!profile) return res.status(503).json({ code: 'PROTECTED_DATA_UNAVAILABLE' });
  return res.json(profile);
});

protectedDataRoutes.post('/', json({ limit: PROTECTED_DATA_MAX_BODY_BYTES }), async (req, res) => {
  const userId = (req as Request & { user?: { id?: string | number } }).user?.id;
  if (userId == null) return res.status(401).json({ code: 'AUTH_REQUIRED' });
  const envelope = readProtectedDataEnvelope(req.body);
  if (!envelope || sessionsDb.getSessionById(envelope.sessionId)?.provider !== 'claude') {
    return res.status(400).json({ code: 'PROTECTED_DATA_INVALID' });
  }
  const id = await protectedDataRelay.stage(String(userId), envelope);
  if (!id) return res.status(409).json({ code: 'PROTECTED_DATA_UNAVAILABLE' });
  return res.status(201).json({ id });
});

// Не передавать тело/исключение парсера общему обработчику ошибок.
const rejectInvalidRequest: ErrorRequestHandler = (_error, _req, res, _next) => {
  res.status(400).json({ code: 'PROTECTED_DATA_INVALID' });
};
protectedDataRoutes.use(rejectInvalidRequest);
