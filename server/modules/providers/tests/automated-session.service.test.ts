import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { isAutomatedToolSession } from '@/modules/providers/services/automated-session.service.js';

let workDir: string;

async function writeTranscript(name: string, records: unknown[]): Promise<string> {
  const filePath = path.join(workDir, name);
  await writeFile(filePath, records.map((record) => JSON.stringify(record)).join('\n'), 'utf8');
  return filePath;
}

const REVIEW_PROMPT =
  'Review this change for security vulnerabilities. Changed files: bot/dispatcher.py';

describe('automated tool session detection', () => {
  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'cloudcli-automated-'));
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('detects a security-review run', async () => {
    const filePath = await writeTranscript('review.jsonl', [
      { type: 'summary', summary: 'ignored' },
      { type: 'user', entrypoint: 'sdk-py', message: { role: 'user', content: REVIEW_PROMPT } },
    ]);

    assert.equal(await isAutomatedToolSession(filePath), true);
  });

  it('detects the follow-up "previously flagged" run', async () => {
    const filePath = await writeTranscript('followup.jsonl', [
      {
        type: 'user',
        entrypoint: 'sdk-py',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'You previously flagged these candidate vulnerabilities: [{...}]' }],
        },
      },
    ]);

    assert.equal(await isAutomatedToolSession(filePath), true);
  });

  it('leaves CloudCLI chats alone even when they discuss security reviews', async () => {
    // The title model names real sessions things like "kb-switch.sh — проверка
    // уязвимостей", so a name- or topic-based rule would hide actual work.
    const filePath = await writeTranscript('human.jsonl', [
      {
        type: 'user',
        entrypoint: 'sdk-ts',
        message: { role: 'user', content: 'Review this change for security vulnerabilities in my repo' },
      },
    ]);

    assert.equal(await isAutomatedToolSession(filePath), false);
  });

  it('ignores a python run whose prompt is not the plugin template', async () => {
    const filePath = await writeTranscript('other-py.jsonl', [
      {
        type: 'user',
        entrypoint: 'sdk-py',
        message: { role: 'user', content: 'Собери отчёт по продажам за август' },
      },
    ]);

    assert.equal(await isAutomatedToolSession(filePath), false);
  });

  it('skips meta turns before deciding', async () => {
    const filePath = await writeTranscript('meta-first.jsonl', [
      { type: 'user', isMeta: true, entrypoint: 'sdk-ts', message: { role: 'user', content: 'служебное' } },
      { type: 'user', entrypoint: 'sdk-py', message: { role: 'user', content: REVIEW_PROMPT } },
    ]);

    assert.equal(await isAutomatedToolSession(filePath), true);
  });

  it('treats an unreadable or empty transcript as a normal session', async () => {
    // Hiding a real conversation is worse than leaving a review one visible.
    assert.equal(await isAutomatedToolSession(path.join(workDir, 'missing.jsonl')), false);

    const empty = await writeTranscript('empty.jsonl', []);
    assert.equal(await isAutomatedToolSession(empty), false);
  });
});
