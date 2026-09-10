import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { archiveAutomatedSessions } from '@/modules/providers/services/automated-session.service.js';

/**
 * Startup sweep for sessions indexed before auto-archiving existed.
 *
 * The scan cursor only moves forward, so a review session indexed by an old
 * build (or before its first prompt line landed) stayed visible forever. The
 * sweep re-inspects every unarchived row's transcript and files the matches
 * away — without touching real conversations or rows it cannot read.
 */
test('startup sweep archives plugin sessions and keeps everything else', async () => {
  const prev = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'sweep-probe-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();

  const projectPath = path.join(dir, 'project');
  const tdir = path.join(dir, 'projects', 'encoded');
  await mkdir(tdir, { recursive: true });
  await mkdir(projectPath, { recursive: true });

  const writeTranscript = async (sessionId: string, lines: unknown[]) => {
    const file = path.join(tdir, `${sessionId}.jsonl`);
    await writeFile(file, lines.map((line) => JSON.stringify(line)).join('\n'), 'utf8');
    return file;
  };

  // «Старый» индекс: строки заведены без проверки на automated.
  const pluginId = 'aaaaaaaa-0000-0000-0000-000000000001';
  const pluginFile = await writeTranscript(pluginId, [
    { sessionId: pluginId, cwd: projectPath, type: 'user' },
    {
      type: 'user',
      entrypoint: 'sdk-py',
      message: { role: 'user', content: 'Review this change for security vulnerabilities. Changed files: a.py' },
    },
  ]);
  sessionsDb.createSession(pluginId, 'claude', projectPath, 'update.sh security review', undefined, undefined, pluginFile);

  const humanId = 'aaaaaaaa-0000-0000-0000-000000000002';
  const humanFile = await writeTranscript(humanId, [
    { sessionId: humanId, cwd: projectPath, type: 'user' },
    { type: 'user', entrypoint: 'sdk-ts', message: { role: 'user', content: 'Почини шапку на телефоне' } },
  ]);
  sessionsDb.createSession(humanId, 'claude', projectPath, 'Почини шапку', undefined, undefined, humanFile);

  // Строка с битым путём не должна ни архивироваться, ни ронять sweep.
  const ghostId = 'aaaaaaaa-0000-0000-0000-000000000003';
  sessionsDb.createSession(ghostId, 'claude', projectPath, 'ghost', undefined, undefined, path.join(tdir, 'missing.jsonl'));

  // Уже заархивированная plugin-сессия не считается повторно.
  const archivedId = 'aaaaaaaa-0000-0000-0000-000000000004';
  sessionsDb.createSession(archivedId, 'claude', projectPath, 'already archived', undefined, undefined, pluginFile, true);

  const archived = await archiveAutomatedSessions();

  assert.equal(archived, 1, 'только plugin-сессия уезжает в архив');
  assert.equal(sessionsDb.getSessionById(pluginId)?.isArchived, 1, 'plugin-сессия заархивирована');
  assert.equal(sessionsDb.getSessionById(humanId)?.isArchived, 0, 'живой чат остаётся видимым');
  assert.equal(sessionsDb.getSessionById(ghostId)?.isArchived, 0, 'битый транскрипт не трогаем');
  assert.equal(sessionsDb.getSessionById(archivedId)?.isArchived, 1, 'архив не раскрывается');

  // Повторный прогон — холостой: работа уже сделана.
  assert.equal(await archiveAutomatedSessions(), 0, 'sweep идемпотентен');

  closeConnection();
  process.env.DATABASE_PATH = prev;
  if (prev === undefined) delete process.env.DATABASE_PATH;
  await rm(dir, { recursive: true, force: true });
});
