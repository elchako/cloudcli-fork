import { sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import type { NormalizedMessage } from '@/shared/types.js';

/**
 * GOLDJAXE fork (реестр §17): the user's own prompts in one session, for the
 * chat's prompt navigator.
 *
 * The client pages history 20 rows at a time, and in a session that runs tools
 * those 20 rows usually hold one prompt or none — so the navigator cannot be
 * built from what the client has loaded. This reads the same full history the
 * pages are sliced from (warm in `sessionHistoryCache` for Claude and Codex)
 * and returns only the prompts, a few hundred bytes each.
 */

/** Longest preview kept per prompt; the navigator shows at most three lines of it. */
const PROMPT_PREVIEW_LENGTH = 280;

/**
 * Context an IDE or the harness attaches to a prompt. The user did not type
 * it, and a preview made of it says nothing about what was asked.
 */
const ATTACHED_CONTEXT_BLOCK = /<(system-reminder|ide_[a-z_]+)>[\s\S]*?<\/\1>/g;

export type SessionPrompt = {
  /**
   * Stable across reads: the transcript row's anchor where the provider keeps
   * one (Claude's row uuid), its timestamp otherwise.
   */
  key: string;
  anchorId?: string;
  /** Exactly the row's timestamp, which is what the client stamps the rendered row with. */
  timestamp: string;
  /**
   * How many history rows, counted back from the end, reach this prompt — the
   * tail `limit` that loads it. Positions from the start would shift with
   * every row the session appends.
   */
  fromEnd: number;
  /** One line of what the user wrote; empty for an attachment-only turn. */
  text: string;
  attachmentCount: number;
  /** A slash command (`/compact`, `/skill args`), drawn quieter than a prompt. */
  isCommand: boolean;
};

export type SessionPromptsResult = {
  prompts: SessionPrompt[];
  /** Rows in the history the positions were counted against. */
  total: number;
};

function toPreview(content: string): string {
  const text = content.replace(ATTACHED_CONTEXT_BLOCK, ' ').replace(/\s+/g, ' ').trim();
  return text.length > PROMPT_PREVIEW_LENGTH ? `${text.slice(0, PROMPT_PREVIEW_LENGTH - 1)}…` : text;
}

function countAttachments(message: NormalizedMessage): number {
  return (Array.isArray(message.images) ? message.images.length : 0)
    + (Array.isArray(message.files) ? message.files.length : 0);
}

/** A row the transcript draws as a user bubble — the rows `normalizedToChatMessages` keeps as `type: 'user'`. */
function isUserBubble(message: NormalizedMessage): boolean {
  return message.kind === 'text'
    && message.role === 'user'
    && !message.parentToolUseId
    // A background task's report arrives as a user row but is drawn as the agent's.
    && !(message.content ?? '').trimStart().startsWith('<task-notification>');
}

/**
 * Picks the prompts out of a full normalized history.
 *
 * One prompt can arrive as several rows — Claude splits a turn's text parts,
 * OpenCode writes a row per part — all with the turn's timestamp, so adjacent
 * user rows with the same timestamp are folded into one prompt.
 */
export function extractSessionPrompts(messages: NormalizedMessage[]): SessionPrompt[] {
  const prompts: SessionPrompt[] = [];
  let lastPromptRowIndex = -2;

  messages.forEach((message, index) => {
    if (!isUserBubble(message)) {
      return;
    }

    const text = toPreview(message.content ?? '');
    const attachmentCount = countAttachments(message);
    if (!text && attachmentCount === 0) {
      return;
    }

    const previous = prompts[prompts.length - 1];
    if (previous && lastPromptRowIndex === index - 1 && previous.timestamp === message.timestamp) {
      previous.text = toPreview([previous.text, text].filter(Boolean).join(' '));
      previous.attachmentCount += attachmentCount;
      lastPromptRowIndex = index;
      return;
    }

    prompts.push({
      key: message.transcriptAnchorId || message.timestamp,
      ...(message.transcriptAnchorId ? { anchorId: message.transcriptAnchorId } : {}),
      timestamp: message.timestamp,
      fromEnd: messages.length - index,
      text,
      attachmentCount,
      isCommand: Boolean(message.isLocalCommand),
    });
    lastPromptRowIndex = index;
  });

  return prompts;
}

export const sessionPromptsService = {
  async listPrompts(sessionId: string): Promise<SessionPromptsResult> {
    // Cursor history carries no time of its own: every read stamps its rows
    // `Date.now() + n × 100 ms`, so neither a key nor a position from here
    // would match the rows the client loaded on an earlier read. The client
    // falls back to the prompts it has loaded itself.
    if (sessionsDb.getSessionById(sessionId)?.provider === 'cursor') {
      return { prompts: [], total: 0 };
    }

    const history = await sessionsService.fetchHistory(sessionId, { limit: null, offset: 0 });
    return {
      prompts: extractSessionPrompts(history.messages),
      total: history.messages.length,
    };
  },
};
