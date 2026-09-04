import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';

/**
 * Titles for freshly created sessions.
 *
 * A live session is re-indexed on every transcript write, so these tests pin the
 * behaviour that broke in practice: the very first pass starts a background
 * title request, and a second pass arriving before the model answered must not
 * treat the still-raw prompt as "already titled".
 */

const RAW_PROMPT = 'у нас есть доработанная версия cloudcli, хочу внести правки в боковую панель и названия сеансов';
const SHORT_TITLE = 'cloudcli — правки боковой панели';

type Harness = {
  synchronizer: ClaudeSessionSynchronizer;
  transcriptPath: string;
  sessionId: string;
  /** Number of title requests the gateway received. */
  requests: () => number;
};

const originalFetch = globalThis.fetch;

/**
 * Builds an isolated DB plus a Claude-shaped transcript on disk.
 *
 * `resolveTitle` decides how the stubbed gateway answers, which is how the
 * tests model a slow model, a failing one, or a race with a manual rename.
 */
async function withHarness(
  resolveTitle: (callIndex: number) => Promise<string | null>,
  runTest: (harness: Harness) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousApiKey = process.env.ANTHROPIC_API_KEY;
  const previousBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-titles-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ANTHROPIC_BASE_URL = 'https://gateway.test';
  await initializeDatabase();

  const sessionId = '11111111-2222-3333-4444-555555555555';
  const projectPath = path.join(tempDirectory, 'project');
  const transcriptDirectory = path.join(tempDirectory, 'projects', 'encoded-project');
  await mkdir(transcriptDirectory, { recursive: true });
  await mkdir(projectPath, { recursive: true });

  const transcriptPath = path.join(transcriptDirectory, `${sessionId}.jsonl`);
  await writeFile(
    transcriptPath,
    [
      JSON.stringify({ sessionId, cwd: projectPath, type: 'user' }),
      JSON.stringify({ type: 'last-prompt', sessionId, lastPrompt: RAW_PROMPT }),
    ].join('\n'),
    'utf8',
  );

  let callIndex = 0;
  let startedRequests = 0;
  globalThis.fetch = (async () => {
    // Counted on entry, not on completion: a test that holds a request open
    // still needs to observe that it was started.
    const currentCall = callIndex++;
    startedRequests += 1;
    const title = await resolveTitle(currentCall);
    if (title === null) {
      return new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
    }

    return new Response(JSON.stringify({ content: [{ type: 'text', text: title }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;

  try {
    await runTest({
      synchronizer: new ClaudeSessionSynchronizer(),
      transcriptPath,
      sessionId,
      requests: () => startedRequests,
    });
  } finally {
    globalThis.fetch = originalFetch;
    closeConnection();
    process.env.DATABASE_PATH = previousDatabasePath;
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    process.env.ANTHROPIC_API_KEY = previousApiKey;
    if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_BASE_URL = previousBaseUrl;
    if (previousBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** Waits until `check` holds, so background titling can settle. */
async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const storedName = (sessionId: string) => sessionsDb.getSessionById(sessionId)?.custom_name?.trim() ?? '';
const storedFullTitle = (sessionId: string) => sessionsDb.getSessionById(sessionId)?.full_title?.trim() ?? '';

test('a newly indexed session gets a short title in the background', async () => {
  await withHarness(
    async () => SHORT_TITLE,
    async ({ synchronizer, transcriptPath, sessionId }) => {
      await synchronizer.synchronizeFile(transcriptPath);

      // The row is stored immediately with the raw prompt — indexing never waits.
      assert.equal(storedName(sessionId), RAW_PROMPT);

      await waitFor(() => storedFullTitle(sessionId) !== '');
      assert.equal(storedName(sessionId), SHORT_TITLE);
      assert.equal(storedFullTitle(sessionId), RAW_PROMPT);
    },
  );
});

test('re-indexing retries titling when the previous pass has not answered yet', async () => {
  let releaseFirstCall: (() => void) | null = null;
  const firstCallGate = new Promise<void>((resolve) => {
    releaseFirstCall = resolve;
  });

  await withHarness(
    async (callIndex) => {
      // Hold the first request open so the second index pass overlaps with it.
      if (callIndex === 0) {
        await firstCallGate;
        return null;
      }

      return SHORT_TITLE;
    },
    async ({ synchronizer, transcriptPath, sessionId, requests }) => {
      await synchronizer.synchronizeFile(transcriptPath);
      assert.equal(storedName(sessionId), RAW_PROMPT);

      // Requests are queued, so wait until the first one actually reached the
      // gateway before checking that a second pass adds nothing.
      await waitFor(() => requests() === 1);

      // Second write while the first request is still in flight: it must not
      // start a duplicate request.
      await synchronizer.synchronizeFile(transcriptPath);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(requests(), 1, 'a session already being titled must not be requested twice');

      // First attempt fails; the stored name is still the raw prompt.
      releaseFirstCall?.();
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(storedName(sessionId), RAW_PROMPT);
      assert.equal(storedFullTitle(sessionId), '');

      // This is the regression: a later pass has to try again rather than treat
      // the raw prompt as a finished title.
      await synchronizer.synchronizeFile(transcriptPath);
      await waitFor(() => storedFullTitle(sessionId) !== '');
      assert.equal(storedName(sessionId), SHORT_TITLE);
    },
  );
});

test('an already titled session is not re-titled on later writes', async () => {
  await withHarness(
    async () => SHORT_TITLE,
    async ({ synchronizer, transcriptPath, sessionId, requests }) => {
      await synchronizer.synchronizeFile(transcriptPath);
      await waitFor(() => storedFullTitle(sessionId) !== '');
      assert.equal(requests(), 1);

      await synchronizer.synchronizeFile(transcriptPath);
      await synchronizer.synchronizeFile(transcriptPath);

      assert.equal(requests(), 1, 'a titled session must not spend further requests');
      assert.equal(storedName(sessionId), SHORT_TITLE);
    },
  );
});

test('a hand-typed rename survives a background title that lands afterwards', async () => {
  let releaseCall: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    releaseCall = resolve;
  });

  await withHarness(
    async () => {
      await gate;
      return SHORT_TITLE;
    },
    async ({ synchronizer, transcriptPath, sessionId }) => {
      await synchronizer.synchronizeFile(transcriptPath);

      // The user renames while the model is still answering.
      sessionsDb.updateSessionTitleWithFullText(sessionId, 'Моё название', null);
      releaseCall?.();

      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(storedName(sessionId), 'Моё название');
      assert.equal(storedFullTitle(sessionId), '');
    },
  );
});

test('stores the title when the display name differs from the prompt source', async () => {
  // Regression: the guard against clobbering a manual rename compared the
  // stored name against the *prompt*. Once the prompt started coming from the
  // transcript's first message while the name still came from `history.jsonl`
  // (or a truncated slice), the two stopped matching and virtually every
  // generated title was discarded — measured at 39 of 40 live sessions.
  await withHarness(
    async () => SHORT_TITLE,
    async ({ synchronizer, transcriptPath, sessionId }) => {
      const displayName = 'Короткое имя из history.jsonl';
      await writeFile(
        transcriptPath,
        [
          JSON.stringify({ sessionId, cwd: path.dirname(transcriptPath), type: 'user' }),
          JSON.stringify({
            type: 'user',
            message: { role: 'user', content: RAW_PROMPT },
          }),
          JSON.stringify({ type: 'custom-title', sessionId, customTitle: displayName }),
        ].join('\n'),
        'utf8',
      );

      await synchronizer.synchronizeFile(transcriptPath);
      await waitFor(() => storedFullTitle(sessionId) !== '');

      assert.equal(storedName(sessionId), SHORT_TITLE);
      assert.equal(storedFullTitle(sessionId), RAW_PROMPT);
    },
  );
});
