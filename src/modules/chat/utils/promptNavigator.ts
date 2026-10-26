import type { ChatMessage } from '@/shared/types';

/**
 * GOLDJAXE fork (реестр §17): the pure half of the chat's prompt navigator —
 * which prompts the session has, and which one the reader is in.
 *
 * The server's list (`GET /sessions/:id/prompts`) is the source of truth: the
 * client holds only the last page or two of history, which in a session that
 * runs tools is usually one prompt. Loaded rows add only what the server list
 * cannot know yet — the prompt just sent, and anything newer than the list.
 */

/** One prompt as the server lists it. */
export type ServerPrompt = {
  key: string;
  anchorId?: string;
  timestamp: string;
  fromEnd: number;
  text: string;
  attachmentCount: number;
  isCommand: boolean;
};

export type PromptEntry = {
  /** The transcript anchor where the provider keeps one, the row's timestamp otherwise. */
  key: string;
  anchorId?: string;
  /** The row's timestamp, as its rendered row carries it in `data-message-timestamp`. */
  timestamp: string;
  text: string;
  attachmentCount: number;
  isCommand: boolean;
  /** The history tail `limit` that loads this prompt; null when only the loaded rows know it. */
  fromEnd: number | null;
};

/** Same cap as the server's preview, so a loaded row and its listed copy compare equal. */
const PREVIEW_LENGTH = 280;

/**
 * The window in which a sent message's optimistic copy still stands for the
 * persisted one: the device clock may run up to 10 s ahead of the server, and
 * the CLI may write the turn minutes after it was sent. Mirrors the store's
 * own echo retirement (`sessionMessageReconciliation.ts`).
 */
const ECHO_CLOCK_SKEW_MS = 10_000;
const ECHO_WINDOW_MS = 5 * 60 * 1000;

function toPreview(content: string): string {
  const text = content.replace(/\s+/g, ' ').trim();
  return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH - 1)}…` : text;
}

const readTime = (timestamp: string): number => Date.parse(timestamp);

/**
 * The prompts among the loaded rows, in order. Adjacent user rows with one
 * timestamp are the parts of a single turn and become one prompt, as on the
 * server.
 */
export function collectLoadedPrompts(messages: ChatMessage[]): PromptEntry[] {
  const prompts: PromptEntry[] = [];
  let lastPromptRowIndex = -2;

  messages.forEach((message, index) => {
    if (message.type !== 'user') {
      return;
    }

    const text = toPreview(String(message.content || ''));
    const attachmentCount = (message.images?.length ?? 0) + (message.files?.length ?? 0);
    if (!text && attachmentCount === 0) {
      return;
    }

    const timestamp = String(message.timestamp);
    const previous = prompts[prompts.length - 1];
    if (previous && lastPromptRowIndex === index - 1 && previous.timestamp === timestamp) {
      previous.text = toPreview([previous.text, text].filter(Boolean).join(' '));
      previous.attachmentCount += attachmentCount;
      lastPromptRowIndex = index;
      return;
    }

    const anchorId = typeof message.transcriptAnchorId === 'string' && message.transcriptAnchorId
      ? message.transcriptAnchorId
      : undefined;
    prompts.push({
      key: anchorId ?? timestamp,
      ...(anchorId ? { anchorId } : {}),
      timestamp,
      text,
      attachmentCount,
      isCommand: Boolean(message.isLocalCommand),
      fromEnd: null,
    });
    lastPromptRowIndex = index;
  });

  return prompts;
}

/**
 * The navigator's list: every prompt the server knows, then the loaded prompts
 * newer than all of them.
 *
 * A loaded prompt with no anchor that is newer than the list may still be the
 * optimistic copy of a turn the list already has (a device clock ahead of the
 * server's): it is dropped when an unclaimed listed prompt with the same words
 * falls inside the echo window. Pairs are one-to-one, so two "yes" sent in a
 * row cannot both retire on one listed "yes".
 *
 * Without a server list — not fetched yet, failed, or a Cursor session — the
 * loaded prompts are all there is.
 */
export function mergePrompts(server: ServerPrompt[] | null, loaded: PromptEntry[]): PromptEntry[] {
  if (!server || server.length === 0) {
    return loaded;
  }

  const listedKeys = new Set<string>();
  const listedTimestamps = new Set<string>();
  let newestListedTime = Number.NEGATIVE_INFINITY;
  for (const prompt of server) {
    listedKeys.add(prompt.key);
    listedTimestamps.add(prompt.timestamp);
    const time = readTime(prompt.timestamp);
    if (Number.isFinite(time) && time > newestListedTime) {
      newestListedTime = time;
    }
  }

  const claimed = new Set<number>();
  const newer = loaded.filter((entry) => {
    if (listedKeys.has(entry.key) || listedTimestamps.has(entry.timestamp)) {
      return false;
    }

    const time = readTime(entry.timestamp);
    if (Number.isFinite(time) && time <= newestListedTime) {
      return false;
    }

    if (!entry.anchorId && Number.isFinite(time)) {
      const echoOf = server.findIndex((prompt, index) => {
        if (claimed.has(index) || prompt.text !== entry.text || prompt.attachmentCount !== entry.attachmentCount) {
          return false;
        }
        const listedTime = readTime(prompt.timestamp);
        return listedTime >= time - ECHO_CLOCK_SKEW_MS && listedTime - time <= ECHO_WINDOW_MS;
      });
      if (echoOf >= 0) {
        claimed.add(echoOf);
        return false;
      }
    }

    return true;
  });

  return [
    ...server.map((prompt) => ({
      key: prompt.key,
      ...(prompt.anchorId ? { anchorId: prompt.anchorId } : {}),
      timestamp: prompt.timestamp,
      text: prompt.text,
      attachmentCount: prompt.attachmentCount,
      isCommand: prompt.isCommand,
      fromEnd: prompt.fromEnd,
    })),
    ...newer,
  ];
}

/** Where a prompt sits among the loaded rows, or -1 when it is not loaded. */
export function findLoadedPromptIndex(messages: ChatMessage[], entry: PromptEntry): number {
  if (entry.anchorId) {
    const byAnchor = messages.findIndex((message) => (
      message.type === 'user' && message.transcriptAnchorId === entry.anchorId
    ));
    if (byAnchor >= 0) {
      return byAnchor;
    }
  }

  return messages.findIndex((message) => (
    message.type === 'user' && String(message.timestamp) === entry.timestamp
  ));
}

/**
 * The prompt whose turn the reader is in.
 *
 * `tops` holds each prompt's row top in scroll coordinates, or null for a
 * prompt with no rendered row. Rendered rows are a tail of the transcript, so
 * the unrendered prompts before the first rendered one are above the screen:
 * when no rendered prompt has reached the reading line, the reader is in the
 * turn of the last of those.
 *
 * At the very bottom a short last turn can never climb to the reading line, so
 * there the last prompt whose row is on screen wins (`viewportBottom`).
 */
export function findActivePromptIndex(
  tops: Array<number | null>,
  readingLine: number,
  viewportBottom: number | null = null,
): number {
  let firstRendered = -1;
  let active = -1;

  for (let index = 0; index < tops.length; index++) {
    const top = tops[index];
    if (top === null) {
      continue;
    }
    if (firstRendered < 0) {
      firstRendered = index;
    }
    if (top <= readingLine) {
      active = index;
    }
  }

  if (firstRendered < 0) {
    return tops.length - 1;
  }
  if (active < 0) {
    active = firstRendered - 1;
  }

  if (viewportBottom !== null) {
    for (let index = tops.length - 1; index > active; index--) {
      const top = tops[index];
      if (top !== null && top < viewportBottom) {
        return index;
      }
    }
  }

  return active;
}
