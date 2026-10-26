import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  extractSessionPrompts,
  sessionPromptsService,
} from '@/modules/providers/services/session-prompts.service.js';
import type { NormalizedMessage } from '@/shared/types.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-prompts-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
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

let rowCounter = 0;
function row(fields: Partial<NormalizedMessage>): NormalizedMessage {
  rowCounter += 1;
  return {
    id: `row-${rowCounter}`,
    sessionId: 'session',
    timestamp: `2026-01-01T00:00:${String(rowCounter % 60).padStart(2, '0')}.000Z`,
    provider: 'claude',
    kind: 'text',
    ...fields,
  } as NormalizedMessage;
}

test('only user bubbles become prompts, with their distance from the end', () => {
  const messages = [
    row({ role: 'user', content: 'first question', transcriptAnchorId: 'a1' }),
    row({ role: 'assistant', content: 'answer' }),
    row({ kind: 'tool_use', toolName: 'Bash', toolId: 't1' }),
    row({ kind: 'tool_result', toolId: 't1', content: 'output' }),
    row({ role: 'user', content: '<task-notification><summary>done</summary></task-notification>' }),
    row({ role: 'user', content: 'subagent prompt', parentToolUseId: 't1' }),
    row({ role: 'user', content: '/compact', isLocalCommand: true, transcriptAnchorId: 'a2' }),
    row({ role: 'user', content: 'second\n\n   question' }),
  ];

  const prompts = extractSessionPrompts(messages);

  assert.deepEqual(prompts.map((prompt) => prompt.text), ['first question', '/compact', 'second question']);
  assert.deepEqual(prompts.map((prompt) => prompt.fromEnd), [8, 2, 1]);
  assert.deepEqual(prompts.map((prompt) => prompt.isCommand), [false, true, false]);
  // The anchor is the key where the provider has one, the timestamp otherwise.
  assert.equal(prompts[0].key, 'a1');
  assert.equal(prompts[0].anchorId, 'a1');
  assert.equal(prompts[2].key, messages[7].timestamp);
  assert.equal(prompts[2].anchorId, undefined);
});

test('the parts of one turn fold into one prompt, separate turns do not', () => {
  const sameTime = '2026-01-01T10:00:00.000Z';
  const messages = [
    row({ role: 'user', content: 'look at this', timestamp: sameTime, images: [{ data: 'x' }] }),
    row({ role: 'user', content: 'and this file', timestamp: sameTime, files: [{ path: '/a' }] }),
    row({ role: 'assistant', content: 'ok', timestamp: '2026-01-01T10:00:05.000Z' }),
    // Same words at the same time but not adjacent: a different turn.
    row({ role: 'user', content: 'yes', timestamp: '2026-01-01T10:00:06.000Z' }),
    row({ role: 'user', content: 'yes', timestamp: '2026-01-01T10:00:07.000Z' }),
  ];

  const prompts = extractSessionPrompts(messages);

  assert.equal(prompts.length, 3);
  assert.equal(prompts[0].text, 'look at this and this file');
  assert.equal(prompts[0].attachmentCount, 2);
  assert.equal(prompts[0].fromEnd, 5);
  assert.deepEqual(prompts.slice(1).map((prompt) => prompt.text), ['yes', 'yes']);
});

test('attached IDE and harness context is not shown as the prompt', () => {
  const prompts = extractSessionPrompts([
    row({ role: 'user', content: '<ide_opened_file>The user opened a.ts</ide_opened_file> fix the bug' }),
    row({ role: 'user', content: '<system-reminder>noise</system-reminder>' }),
    row({ role: 'user', content: '', images: [{ data: 'x' }] }),
    row({ role: 'user', content: 'x'.repeat(400) }),
  ]);

  assert.equal(prompts[0].text, 'fix the bug');
  // Context alone is not a prompt; an attachment alone is.
  assert.equal(prompts.length, 3);
  assert.equal(prompts[1].text, '');
  assert.equal(prompts[1].attachmentCount, 1);
  assert.equal(prompts[2].text.length, 280);
  assert.ok(prompts[2].text.endsWith('…'));
});

function claudeRow(sessionId: string, role: 'user' | 'assistant', text: string, ordinal: number) {
  return {
    type: role,
    uuid: `uuid-${ordinal}`,
    parentUuid: ordinal === 0 ? null : `uuid-${ordinal - 1}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, ordinal)).toISOString(),
    sessionId,
    message: { role, content: [{ type: 'text', text }] },
  };
}

test('a Claude session lists its prompts keyed by row uuid', { concurrency: false }, async () => {
  const transcriptDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-prompts-history-'));
  const sessionId = 'claude-prompts-session';
  const transcriptPath = path.join(transcriptDirectory, `${sessionId}.jsonl`);

  try {
    await withIsolatedDatabase(async () => {
      const rows = [
        claudeRow(sessionId, 'user', 'what can you do', 0),
        claudeRow(sessionId, 'assistant', 'many things', 1),
        claudeRow(sessionId, 'user', '[Request interrupted by user]', 2),
        claudeRow(sessionId, 'user', 'write a note', 3),
        claudeRow(sessionId, 'assistant', 'here it is', 4),
      ];
      await writeFile(transcriptPath, `${rows.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
      sessionsDb.createSession(
        sessionId,
        'claude',
        '/tmp/session-prompts-project',
        'Prompts conversation',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:10.000Z',
        transcriptPath,
      );

      const result = await sessionPromptsService.listPrompts(sessionId);

      assert.deepEqual(result.prompts.map((prompt) => prompt.text), ['what can you do', 'write a note']);
      assert.deepEqual(result.prompts.map((prompt) => prompt.key), ['uuid-0', 'uuid-3']);
      assert.deepEqual(result.prompts.map((prompt) => prompt.timestamp), [rows[0].timestamp, rows[3].timestamp]);
      // `fromEnd` is a tail limit against the same history the pages come from.
      assert.equal(result.total, 4);
      assert.deepEqual(result.prompts.map((prompt) => prompt.fromEnd), [4, 2]);
    });
  } finally {
    await rm(transcriptDirectory, { recursive: true, force: true });
  }
});

test('a Cursor session lists nothing: its history has no stable time', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('cursor-prompts-session', 'cursor', '/tmp/cursor-prompts-project');

    const result = await sessionPromptsService.listPrompts('cursor-prompts-session');

    assert.deepEqual(result, { prompts: [], total: 0 });
  });
});
