import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import { sessionsDb } from '@/modules/database/index.js';

/**
 * Recognises sessions a tool started on the user's behalf.
 *
 * The security-review plugin opens a Claude session per commit — often two —
 * so on a busy repo its transcripts outnumber real conversations several times
 * over (measured on this install: 907 of 1167 indexed sessions). They are
 * useful to keep, but not to scroll past when looking for a chat one actually
 * had, so indexing files them straight into the existing archive.
 *
 * Detection deliberately does NOT look at the session title: those are written
 * by the title model and read like ordinary work ("kb-switch.sh — проверка
 * уязвимостей"), so a name-based rule would archive real conversations too.
 * Instead it matches the two things the plugin controls itself — the SDK
 * entrypoint that launched the run and the fixed opening line of its prompt.
 * On this install that pair matched 907 of 907 plugin sessions with zero false
 * positives across the other 260.
 */

/** Opening lines the review plugin always sends as its first message. */
const AUTOMATED_PROMPT_MARKERS = [
  /^Review this change for security vulnerabilities/i,
  /^You previously flagged these candidate vulnerabilities/i,
];

/**
 * SDK entrypoints that never correspond to a human sitting in the UI.
 *
 * CloudCLI itself reports `sdk-ts`, so restricting the rule to `sdk-py` keeps
 * every chat started from this app out of scope no matter what it contains.
 */
const AUTOMATED_ENTRYPOINTS = new Set(['sdk-py']);

/**
 * How much of a transcript the detector may scan before giving up. The
 * deciding turn is always the first human-visible one, a few lines in — the
 * cap only guards against a pathological single-line transcript eating
 * memory. Well past the largest observed machine prompt (multi-KB payloads).
 */
const MAX_SCAN_BYTES = 8 * 1024 * 1024;

type TranscriptLine = Record<string, unknown>;

/**
 * The verdict one parsed line produces: `null` keeps the scan going, a
 * boolean ends it. Only a turn that actually holds content decides — see the
 * caller for why bookkeeping records are skipped.
 */
function classifyTranscriptLine(data: TranscriptLine): boolean | null {
  if (data.type !== 'user' || data.isMeta === true) {
    return null;
  }

  if (!data.message) {
    return null;
  }

  const entrypoint = typeof data.entrypoint === 'string' ? data.entrypoint : '';
  if (!AUTOMATED_ENTRYPOINTS.has(entrypoint)) {
    // The first human-visible turn decides; a session that opens with a UI
    // prompt is a real conversation whatever follows.
    return false;
  }

  const message = data.message as Record<string, unknown> | undefined;
  const rawContent = message?.content;
  const text = typeof rawContent === 'string'
    ? rawContent
    : Array.isArray(rawContent)
      ? rawContent
          .filter((block): block is { type: string; text: string } => {
            const candidate = block as Record<string, unknown> | null;
            return candidate?.type === 'text' && typeof candidate.text === 'string';
          })
          .map((block) => block.text)
          .join(' ')
      : '';

  return AUTOMATED_PROMPT_MARKERS.some((marker) => marker.test(text.trim()));
}

/** True when the first user turn of a transcript is a tool-issued prompt. */
export async function isAutomatedToolSession(filePath: string): Promise<boolean> {
  // Streamed rather than read whole: the deciding line sits at the top of the
  // transcript, and full reads made every sync (and the startup sweep below)
  // pay the size of the longest sessions — tens of MB — to answer a question
  // about line three.
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  let scannedBytes = 0;

  try {
    for await (const line of reader) {
      scannedBytes += line.length + 1;
      if (scannedBytes > MAX_SCAN_BYTES) {
        return false;
      }

      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const verdict = classifyTranscriptLine(parsed as TranscriptLine);
      if (verdict !== null) {
        return verdict;
      }
    }
  } catch {
    // An unreadable transcript is never assumed to be automated: hiding a real
    // session is far worse than leaving a review one visible.
  } finally {
    reader.close();
    stream.destroy();
  }

  return false;
}

/**
 * Archives already-indexed sessions that look like tool-issued runs.
 *
 * Auto-archiving on insert only covers sessions the indexer (re)parses, and
 * the scan cursor is incremental: a session indexed before this feature (or
 * by an older build, or milliseconds before its first prompt line was
 * flushed) is never re-evaluated and stays visible in the sidebar forever.
 * This sweep walks every unarchived Claude row that has a transcript on disk
 * and files the matches away. Idempotent by construction, so it runs at every
 * boot as the safety net for live-detection races.
 */
export async function archiveAutomatedSessions(): Promise<number> {
  const candidates = sessionsDb.getUnarchivedSessionsWithTranscriptPath('claude');
  let archived = 0;

  // Sequential on purpose: the sweep is a background task and must not turn
  // into a thousand concurrent transcript reads against the boot process.
  for (const candidate of candidates) {
    try {
      if (await isAutomatedToolSession(candidate.jsonl_path)) {
        sessionsDb.updateSessionIsArchived(candidate.session_id, true);
        archived += 1;
      }
    } catch {
      // A row whose transcript vanished mid-sweep is skipped, not archived.
    }
  }

  return archived;
}
