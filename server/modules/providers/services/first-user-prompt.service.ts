import { readFile } from 'node:fs/promises';

/** Starts of `role: 'user'` texts that are machinery, not a human prompt. */
const MACHINERY_PREFIXES = ['<', 'Caveat:', '[Request interrupted'] as const;

/**
 * Recovers the first real user message from a Claude transcript.
 *
 * Two callers need it and must agree on the answer: the synchronizer, which
 * picks a title source while indexing, and the manual "regenerate title"
 * action, which has nothing but the stored row to work from. The stored name
 * is capped at 120 chars — and for sessions started in the web UI it can be a
 * much shorter slice — so re-reading the transcript is the only way to get the
 * untruncated prompt the title model should actually see.
 *
 * Tool results, slash-command wrappers and system reminders arrive with
 * `role: 'user'` as well; titling a session from one of those yields names
 * like "Caveat: The messages below were generated…", so they are skipped.
 *
 * The same goes for the `[Request interrupted by user]` marker: a first turn
 * stopped before the CLI checked its prompt ("prompt_check") leaves only that
 * marker behind, and the real prompt follows as the next turn. Titling from the
 * marker named the session "[Request interrupted by user]", and since it is
 * shorter than the "already its own label" threshold, regenerating could never
 * fix it.
 */
export async function extractFirstUserPrompt(filePath: string): Promise<string | undefined> {
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

      const normalized = text.replace(/\s+/g, ' ').trim();
      if (!normalized) {
        continue;
      }

      // `<command-name>`, `<local-command-…>`, `<files_input>`, the caveat
      // banner and the interruption marker are machinery, not something the
      // user asked for.
      if (MACHINERY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
        continue;
      }

      return normalized;
    }
  } catch {
    // A missing or unreadable transcript just means "no better source".
  }

  return undefined;
}
