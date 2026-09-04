import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';

/**
 * Auto-archiving of tool-generated sessions.
 *
 * The security-review plugin opens a session per commit, which buried real
 * conversations in the sidebar (907 of 2043 rows on the author's install).
 * Indexing now files them into the existing archive instead. Re-indexing is
 * the part that actually broke first: `createSession` un-archives a row on
 * every write, and the plugin keeps appending to its transcripts.
 */
test('a review session is archived on index and stays archived when re-indexed', async () => {
  const prev = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'archive-probe-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();

  const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const projectPath = path.join(dir, 'project');
  const tdir = path.join(dir, 'projects', 'encoded');
  await mkdir(tdir, { recursive: true });
  await mkdir(projectPath, { recursive: true });
  const file = path.join(tdir, `${sessionId}.jsonl`);

  const lines = [
    JSON.stringify({ sessionId, cwd: projectPath, type: 'user' }),
    JSON.stringify({
      type: 'user',
      entrypoint: 'sdk-py',
      message: { role: 'user', content: 'Review this change for security vulnerabilities. Changed files: a.py' },
    }),
  ];
  await writeFile(file, lines.join('\n'), 'utf8');

  const sync = new ClaudeSessionSynchronizer();
  const id = await sync.synchronizeFile(file);
  assert.equal(sessionsDb.getSessionById(id!)?.isArchived, 1, 'должен уехать в архив сразу');

  // Плагин дописывает в транскрипт — раньше это возвращало сеанс в сайдбар.
  await writeFile(file, [...lines, JSON.stringify({ type: 'assistant', message: {} })].join('\n'), 'utf8');
  await sync.synchronizeFile(file);
  assert.equal(sessionsDb.getSessionById(id!)?.isArchived, 1, 'должен остаться в архиве');

  // Обычный чат в архив не уезжает.
  const humanId = 'ffffffff-1111-2222-3333-444444444444';
  const humanFile = path.join(tdir, `${humanId}.jsonl`);
  await writeFile(humanFile, [
    JSON.stringify({ sessionId: humanId, cwd: projectPath, type: 'user' }),
    JSON.stringify({ type: 'user', entrypoint: 'sdk-ts', message: { role: 'user', content: 'Привет, поправь вёрстку' } }),
  ].join('\n'), 'utf8');
  const hid = await sync.synchronizeFile(humanFile);
  assert.equal(sessionsDb.getSessionById(hid!)?.isArchived, 0, 'живой чат остаётся видимым');

  closeConnection();
  process.env.DATABASE_PATH = prev;
  if (prev === undefined) delete process.env.DATABASE_PATH;
  await rm(dir, { recursive: true, force: true });
});
