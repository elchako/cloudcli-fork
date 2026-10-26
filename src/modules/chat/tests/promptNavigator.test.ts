import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import {
  collectLoadedPrompts,
  findActivePromptIndex,
  findLoadedPromptIndex,
  mergePrompts,
} from '@/modules/chat/utils/promptNavigator';
import type { ServerPrompt } from '@/modules/chat/utils/promptNavigator';
import type { ChatMessage } from '@/shared/types';

/**
 * GOLDJAXE fork (реестр §17). The navigator's list is the server's, because
 * the client holds only the last page or two of history; loaded rows add only
 * what the list cannot know yet. These pin the seams where that goes wrong: a
 * prompt shown twice (its optimistic copy beside the persisted one), a prompt
 * dropped, a turn split into several bars, the wrong prompt marked current.
 */

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, second)).toISOString();

const user = (content: string, second: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  type: 'user',
  content,
  timestamp: at(second),
  ...extra,
});

const assistant = (content: string, second: number): ChatMessage => ({
  type: 'assistant',
  content,
  timestamp: at(second),
});

const listed = (text: string, second: number, extra: Partial<ServerPrompt> = {}): ServerPrompt => ({
  key: extra.anchorId ?? at(second),
  timestamp: at(second),
  fromEnd: 100 - second,
  text,
  attachmentCount: 0,
  isCommand: false,
  ...extra,
});

describe('collectLoadedPrompts', () => {
  test('keeps user bubbles only, as one line each', () => {
    const prompts = collectLoadedPrompts([
      user('what   can\n you do', 1, { transcriptAnchorId: 'a1' }),
      assistant('many things', 2),
      { type: 'assistant', content: 'done', timestamp: at(3), isTaskNotification: true },
      user('/compact', 4, { isLocalCommand: true }),
    ]);

    assert.deepEqual(prompts.map((prompt) => prompt.text), ['what can you do', '/compact']);
    assert.equal(prompts[0].key, 'a1');
    assert.equal(prompts[1].key, at(4));
    assert.equal(prompts[1].isCommand, true);
    assert.ok(prompts.every((prompt) => prompt.fromEnd === null));
  });

  test('folds the parts of one turn, keeps an attachment-only turn', () => {
    const prompts = collectLoadedPrompts([
      user('look', 1, { images: [{ data: 'x' }] }),
      user('here', 1, { files: [{ path: '/a' }] }),
      assistant('ok', 2),
      user('', 3, { images: [{ data: 'y' }] }),
      user('', 4),
    ]);

    assert.equal(prompts.length, 2);
    assert.equal(prompts[0].text, 'look here');
    assert.equal(prompts[0].attachmentCount, 2);
    assert.equal(prompts[1].text, '');
    assert.equal(prompts[1].attachmentCount, 1);
  });
});

describe('mergePrompts', () => {
  test('without a server list the loaded prompts are the list', () => {
    const loaded = collectLoadedPrompts([user('a', 1), user('b', 2)]);
    assert.equal(mergePrompts(null, loaded), loaded);
    assert.equal(mergePrompts([], loaded), loaded);
  });

  test('the server list leads; loaded copies of listed prompts are not repeated', () => {
    const server = [
      listed('first', 1, { anchorId: 'a1' }),
      listed('second', 10),
    ];
    const loaded = collectLoadedPrompts([
      user('first', 1, { transcriptAnchorId: 'a1' }),
      user('second', 10),
    ]);

    const merged = mergePrompts(server, loaded);

    assert.deepEqual(merged.map((entry) => entry.text), ['first', 'second']);
    assert.deepEqual(merged.map((entry) => entry.fromEnd), [99, 90]);
  });

  test('a prompt newer than the list is added after it', () => {
    const merged = mergePrompts(
      [listed('first', 1)],
      collectLoadedPrompts([user('first', 1), user('just sent', 30)]),
    );

    assert.deepEqual(merged.map((entry) => entry.text), ['first', 'just sent']);
    assert.equal(merged[1].fromEnd, null);
  });

  test('a loaded row older than the newest listed prompt defers to the list', () => {
    // A stray optimistic row the store never retired, from before the list.
    const merged = mergePrompts(
      [listed('first', 1), listed('second', 20)],
      collectLoadedPrompts([user('stale echo', 5)]),
    );

    assert.deepEqual(merged.map((entry) => entry.text), ['first', 'second']);
  });

  test('an optimistic copy stamped by a clock ahead of the server is not shown twice', () => {
    // Sent at 12:00:40 by the phone's clock; persisted at 12:00:35 by the server's.
    const merged = mergePrompts(
      [listed('first', 1), listed('continue', 35)],
      collectLoadedPrompts([user('continue', 40)]),
    );

    assert.deepEqual(merged.map((entry) => entry.text), ['first', 'continue']);
  });

  test('echo pairs are one-to-one: a second "yes" is its own prompt', () => {
    const merged = mergePrompts(
      [listed('yes', 35)],
      collectLoadedPrompts([user('yes', 40), assistant('ok', 41), user('yes', 42)]),
    );

    assert.deepEqual(merged.map((entry) => entry.text), ['yes', 'yes']);
  });
});

describe('findLoadedPromptIndex', () => {
  const messages = [
    user('first', 1, { transcriptAnchorId: 'a1' }),
    assistant('reply', 2),
    user('second', 3),
  ];

  test('finds a prompt by anchor, then by timestamp', () => {
    assert.equal(findLoadedPromptIndex(messages, { ...listed('first', 99), anchorId: 'a1' }), 0);
    assert.equal(findLoadedPromptIndex(messages, listed('second', 3)), 2);
  });

  test('an assistant row at the same time is not the prompt', () => {
    assert.equal(findLoadedPromptIndex(messages, listed('reply', 2)), -1);
  });

  test('a prompt outside the loaded rows is not found', () => {
    assert.equal(findLoadedPromptIndex(messages, listed('older', 0)), -1);
  });
});

describe('findActivePromptIndex', () => {
  test('the last prompt above the reading line is current', () => {
    assert.equal(findActivePromptIndex([0, 500, 1200], 600), 1);
    assert.equal(findActivePromptIndex([0, 500, 1200], 1300), 2);
  });

  test('above the first rendered prompt, the reader is in the turn of the unrendered one before it', () => {
    // Prompts 0 and 1 are older than the rendered window.
    assert.equal(findActivePromptIndex([null, null, 800, 1600], 300), 1);
    assert.equal(findActivePromptIndex([800, 1600], 300), -1);
  });

  test('with no prompt rendered, the reader is past the last one', () => {
    assert.equal(findActivePromptIndex([null, null, null], 300), 2);
  });

  test('at the bottom, a last prompt that cannot reach the line still becomes current', () => {
    assert.equal(findActivePromptIndex([0, 900, 1500], 1000, 1700), 2);
    // Its row below the screen does not count.
    assert.equal(findActivePromptIndex([0, 900, 1800], 1000, 1700), 1);
  });
});
