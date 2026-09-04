import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { extractFirstUserPrompt } from '@/modules/providers/services/first-user-prompt.service.js';

let workDir: string;

/** Writes a transcript whose lines are the given JSONL records. */
async function writeTranscript(name: string, records: unknown[]): Promise<string> {
  const filePath = path.join(workDir, name);
  await writeFile(filePath, records.map((record) => JSON.stringify(record)).join('\n'), 'utf8');
  return filePath;
}

describe('first user prompt extraction', () => {
  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'cloudcli-prompt-'));
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('returns the untruncated first prompt', async () => {
    const prompt = 'Надо разобраться, почему на телефоне каждый раз просят логин и пароль.';
    const filePath = await writeTranscript('plain.jsonl', [
      { type: 'summary', summary: 'ignored' },
      { type: 'user', message: { role: 'user', content: prompt } },
      { type: 'user', message: { role: 'user', content: 'второй запрос' } },
    ]);

    assert.equal(await extractFirstUserPrompt(filePath), prompt);
  });

  it('joins text blocks and collapses whitespace', async () => {
    const filePath = await writeTranscript('blocks.jsonl', [
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'image', source: {} },
            { type: 'text', text: '  Первая\n\nчасть  ' },
            { type: 'text', text: 'вторая часть' },
          ],
        },
      },
    ]);

    assert.equal(await extractFirstUserPrompt(filePath), 'Первая часть вторая часть');
  });

  it('skips machinery and returns the first human message', async () => {
    // Tool results, slash commands and the caveat banner all arrive as `user`
    // turns; titling from one of them produced names like "Caveat: The
    // messages below were generated…".
    const filePath = await writeTranscript('machinery.jsonl', [
      { type: 'user', isMeta: true, message: { role: 'user', content: 'служебное' } },
      { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
      { type: 'user', message: { role: 'user', content: 'Caveat: The messages below were generated…' } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
      { type: 'user', message: { role: 'user', content: 'Настоящий вопрос пользователя' } },
    ]);

    assert.equal(await extractFirstUserPrompt(filePath), 'Настоящий вопрос пользователя');
  });

  it('tolerates malformed lines and returns undefined when nothing matches', async () => {
    const filePath = path.join(workDir, 'broken.jsonl');
    await writeFile(filePath, 'не json\n{"type":"assistant"}\n\n', 'utf8');

    assert.equal(await extractFirstUserPrompt(filePath), undefined);
  });

  it('returns undefined for a missing file instead of throwing', async () => {
    assert.equal(await extractFirstUserPrompt(path.join(workDir, 'nope.jsonl')), undefined);
  });
});
