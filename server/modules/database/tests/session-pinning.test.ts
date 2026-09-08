import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

/**
 * Pinning keeps a conversation reachable once a list grows past a screenful.
 *
 * The flag lives on the session rather than on a view, so the two lists that
 * can show the same session — its own project, and the cross-project
 * Conversations feed — have to agree about it. These tests pin that contract
 * down: the ordering in both lists, and the one thing pinning must NOT do,
 * which is count as activity.
 */

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-pinning-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const WORKSPACE = '/workspace/pinning-project';

/** Creates one session with an explicit activity timestamp. */
function seedSession(sessionId: string, updatedAt: string): void {
  sessionsDb.createSession(
    sessionId,
    'claude',
    WORKSPACE,
    `name of ${sessionId}`,
    updatedAt,
    updatedAt,
    `/transcripts/${sessionId}.jsonl`,
  );
}

test('a new session starts unpinned', async () => {
  await withIsolatedDatabase(() => {
    seedSession('fresh-session', '2026-09-01T10:00:00.000Z');

    const session = sessionsDb.getSessionById('fresh-session');
    assert.equal(session?.isPinned, 0);
  });
});

test('toggling flips the flag and reports the state it wrote', async () => {
  await withIsolatedDatabase(() => {
    seedSession('toggled-session', '2026-09-01T10:00:00.000Z');

    assert.equal(sessionsDb.toggleSessionPinned('toggled-session'), true);
    assert.equal(sessionsDb.getSessionById('toggled-session')?.isPinned, 1);

    assert.equal(sessionsDb.toggleSessionPinned('toggled-session'), false);
    assert.equal(sessionsDb.getSessionById('toggled-session')?.isPinned, 0);
  });
});

test('toggling an unknown session reports null rather than inventing a row', async () => {
  await withIsolatedDatabase(() => {
    // The route turns this into a 404; a silent `false` would claim a state
    // that was never written anywhere.
    assert.equal(sessionsDb.toggleSessionPinned('no-such-session'), null);
  });
});

test('pinning does not count as activity', async () => {
  await withIsolatedDatabase(() => {
    seedSession('quiet-session', '2026-09-01T10:00:00.000Z');
    const before = sessionsDb.getSessionById('quiet-session')?.updated_at;

    sessionsDb.toggleSessionPinned('quiet-session');

    // Touching updated_at would reorder the very list the pin exists to
    // stabilize, and would misreport when the conversation was last used.
    assert.equal(sessionsDb.getSessionById('quiet-session')?.updated_at, before);
  });
});

test('a pinned session sorts above more recent ones in its project', async () => {
  await withIsolatedDatabase(() => {
    seedSession('older-session', '2026-09-01T10:00:00.000Z');
    seedSession('newer-session', '2026-09-02T10:00:00.000Z');

    sessionsDb.toggleSessionPinned('older-session');

    const sessions = sessionsDb.getSessionsByProjectPathPage(WORKSPACE, 10, 0);
    assert.deepEqual(
      sessions.map((session) => session.session_id),
      ['older-session', 'newer-session'],
    );
  });
});

test('a pinned session sorts to the top of the Conversations feed too', async () => {
  await withIsolatedDatabase(() => {
    seedSession('older-session', '2026-09-01T10:00:00.000Z');
    seedSession('newer-session', '2026-09-02T10:00:00.000Z');

    sessionsDb.toggleSessionPinned('older-session');

    const page = sessionsDb.getRecentSessionsPage(10, 0);
    assert.deepEqual(
      page.sessions.map((session) => session.session_id),
      ['older-session', 'newer-session'],
    );
  });
});

test('pinned sessions keep recency order among themselves', async () => {
  await withIsolatedDatabase(() => {
    seedSession('pinned-old', '2026-09-01T10:00:00.000Z');
    seedSession('pinned-new', '2026-09-03T10:00:00.000Z');
    seedSession('unpinned', '2026-09-02T10:00:00.000Z');

    sessionsDb.toggleSessionPinned('pinned-old');
    sessionsDb.toggleSessionPinned('pinned-new');

    // Pinning promotes a group, it does not flatten it: within the pinned
    // block the usual most-recent-first order still applies.
    const page = sessionsDb.getRecentSessionsPage(10, 0);
    assert.deepEqual(
      page.sessions.map((session) => session.session_id),
      ['pinned-new', 'pinned-old', 'unpinned'],
    );
  });
});

test('an archived session stays out of the lists even when pinned', async () => {
  await withIsolatedDatabase(() => {
    seedSession('archived-session', '2026-09-03T10:00:00.000Z');
    seedSession('visible-session', '2026-09-01T10:00:00.000Z');

    sessionsDb.toggleSessionPinned('archived-session');
    sessionsDb.updateSessionIsArchived('archived-session', true);

    // Archiving is a stronger statement than pinning: a pinned row that was
    // then archived must not climb back into view.
    const page = sessionsDb.getRecentSessionsPage(10, 0);
    assert.deepEqual(
      page.sessions.map((session) => session.session_id),
      ['visible-session'],
    );
  });
});
