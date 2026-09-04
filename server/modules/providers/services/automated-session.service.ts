import { readFile } from 'node:fs/promises';

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

/** True when the first user turn of a transcript is a tool-issued prompt. */
export async function isAutomatedToolSession(filePath: string): Promise<boolean> {
  try {
    const content = await readFile(filePath, 'utf8');

    for (const line of content.split(/\r?\n/)) {
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

      const data = parsed as Record<string, unknown>;
      if (data.type !== 'user' || data.isMeta === true) {
        continue;
      }

      // Transcripts open with bookkeeping records (`queue-operation`, session
      // headers) that can also carry `type: 'user'` without a message body.
      // Only a turn that actually holds content decides the verdict.
      if (!data.message) {
        continue;
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
  } catch {
    // An unreadable transcript is never assumed to be automated: hiding a real
    // session is far worse than leaving a review one visible.
  }

  return false;
}
