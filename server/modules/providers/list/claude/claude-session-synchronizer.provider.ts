import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import {
  buildLookupMap,
  extractFirstValidJsonlData,
  findFilesRecursivelyCreatedAfter,
  normalizeSessionName,
  readFileTimestamps,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import { generateSessionTitle } from '@/modules/providers/services/session-title.service.js';
import { extractFirstUserPrompt } from '@/modules/providers/services/first-user-prompt.service.js';
import { isAutomatedToolSession } from '@/modules/providers/services/automated-session.service.js';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
  /** Raw first prompt this session's title should be built from. */
  rawPrompt?: string | null;
};

/**
 * Session indexer for Claude transcript artifacts.
 */
export class ClaudeSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'claude' as const;
  private readonly claudeHome = path.join(os.homedir(), '.claude');

  /**
   * Sessions whose title is being generated right now.
   *
   * An active session is re-indexed on every transcript write, which happens far
   * faster than the title model answers. Without this guard each write would
   * queue another request for the same session.
   */
  private readonly titlesInFlight = new Set<string>();

  /**
   * Returns true when a JSONL file is a subagent transcript or tool result
   * rather than a top-level session.
   *
   * Claude stores subagent transcripts under a `subagents/` directory and
   * tool results under a `tool-results/` directory, e.g.
   * `~/.claude/projects/<encoded-cwd>/<session-id>/subagents/agent-<id>.jsonl`.
   * Those files repeat the parent session's `sessionId`, so indexing them as
   * standalone sessions overwrites the parent row's `jsonl_path` and corrupts
   * the main session record. The recursive scan in `synchronize()` reaches
   * them, so both entry points must skip them.
   */
  private isSubagentTranscript(filePath: string): boolean {
    const pathParts = path.normalize(filePath).split(path.sep);
    return pathParts.includes('subagents') || pathParts.includes('tool-results');
  }

  /**
   * Scans ~/.claude/projects and upserts discovered sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    const nameMap = await buildLookupMap(path.join(this.claudeHome, 'history.jsonl'), 'sessionId', 'display');
    const files = await findFilesRecursivelyCreatedAfter(
      path.join(this.claudeHome, 'projects'),
      '.jsonl',
      since ?? null
    );

    let processed = 0;
    for (const filePath of files) {
      if (this.isSubagentTranscript(filePath)) {
        continue;
      }

      const parsed = await this.processSessionFile(filePath, nameMap);
      if (!parsed) {
        continue;
      }

      const timestamps = await readFileTimestamps(filePath);
      const isAutomated = await isAutomatedToolSession(filePath);
      const storedSessionId = sessionsDb.createSession(
        parsed.sessionId,
        this.provider,
        parsed.projectPath,
        parsed.sessionName,
        timestamps.createdAt,
        timestamps.updatedAt,
        filePath,
        isAutomated
      );
      // Archived rows are not browsed, and their "prompt" is a multi-KB machine
      // payload — titling them would only burn gateway calls.
      if (!isAutomated) {
        this.scheduleTitle(storedSessionId, parsed);
      }
      processed += 1;
    }

    return processed;
  }

  /**
   * Parses and upserts one Claude session JSONL file.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }
    if (this.isSubagentTranscript(filePath)) {
      return null;
    }

    const nameMap = await buildLookupMap(path.join(this.claudeHome, 'history.jsonl'), 'sessionId', 'display');
    const parsed = await this.processSessionFile(filePath, nameMap);
    if (!parsed) {
      return null;
    }

    const timestamps = await readFileTimestamps(filePath);
    const isAutomated = await isAutomatedToolSession(filePath);
    const storedSessionId = sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      parsed.projectPath,
      parsed.sessionName,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath,
      isAutomated
    );
    if (!isAutomated) {
      this.scheduleTitle(storedSessionId, parsed);
    }

    return storedSessionId;
  }

  /**
   * Shortens a stored session title in the background.
   *
   * Deliberately not awaited: `/api/projects` waits for a full synchronize, and
   * a first run indexes every transcript on disk. Awaiting one network call per
   * session there stalls the whole project list behind the title model. The row
   * is already stored with the raw prompt, so a failure here just leaves the
   * previous behaviour in place.
   *
   * A live session is re-indexed on every transcript write — far more often
   * than the model answers — so `titlesInFlight` keeps one request per session
   * instead of one per keystroke.
   */
  private scheduleTitle(storedSessionId: string | null, parsed: ParsedSession): void {
    const prompt = parsed.rawPrompt?.trim();
    if (!storedSessionId || !prompt || this.titlesInFlight.has(storedSessionId)) {
      return;
    }

    // The name this run is allowed to overwrite — whatever was just stored.
    const storedName = normalizeSessionName(parsed.sessionName, 'Untitled Claude Session');

    this.titlesInFlight.add(storedSessionId);
    void (async () => {
      try {
        const generated = await generateSessionTitle(prompt);
        // Nothing to store when the fallback returned the same raw prompt.
        if (!generated?.generated) {
          return;
        }

        // The model answers in seconds, during which the user may have renamed
        // the session by hand. Re-read the row and only replace the name this
        // run started from: a set `full_title`, or a name that changed while
        // the request was in flight, means someone else won and this result is
        // dropped.
        //
        // Compare against the name that was actually stored, NOT against the
        // prompt. The title source is the transcript's first message, while
        // the stored name comes from `history.jsonl` or a truncated slice — so
        // the two rarely match, and comparing them threw away nearly every
        // generated title (measured: 39 of 40 live sessions).
        const current = sessionsDb.getSessionById(storedSessionId);
        const stillUntitled = !current?.full_title?.trim()
          && current?.custom_name?.trim() === storedName;
        if (!stillUntitled) {
          return;
        }

        sessionsDb.updateSessionTitleWithFullText(
          storedSessionId,
          generated.title,
          generated.fullTitle,
        );
      } catch (error) {
        // A missing short title must never break session indexing.
        console.warn('Failed to generate a session title:', error);
      } finally {
        this.titlesInFlight.delete(storedSessionId);
      }
    })();
  }

  /**
   * Extracts session metadata from one Claude JSONL session file.
   */
  private async processSessionFile(
    filePath: string,
    nameMap: Map<string, string>
  ): Promise<ParsedSession | null> {
    const parsed = await extractFirstValidJsonlData(filePath, (rawData) => {
      const data = rawData as Record<string, unknown>;
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
      const projectPath = typeof data.cwd === 'string' ? data.cwd : undefined;

      if (!sessionId || !projectPath) {
        return null;
      }

      return {
        sessionId,
        projectPath,
      };
    });

    if (!parsed) {
      return null;
    }

    // App-created sessions are keyed by an app id, so disk-discovered provider
    // ids must be resolved through the provider-id mapping first.
    const existingSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
      ?? sessionsDb.getSessionById(parsed.sessionId);
    const existingSessionName = existingSession?.custom_name;
    if (existingSessionName && existingSessionName !== 'Untitled Claude Session') {
      // A live session is re-indexed on every transcript write. `full_title` is
      // only set once a short title was actually produced, so while it is empty
      // the stored name is still the raw prompt and titling has to be retried —
      // otherwise a session whose first pass lost the race to the next write
      // keeps its untruncated prompt forever.
      //
      // A hand-typed rename also leaves `full_title` empty, so it is retried
      // too, but `scheduleTitle` compares the stored name against the prompt it
      // started from and bails out on a mismatch — a manual title survives.
      const alreadyTitled = Boolean(existingSession?.full_title?.trim());
      // `custom_name` is capped at 120 chars, so prefer the untruncated prompt.
      // `history.jsonl` has no entry for app-created sessions, and the stored
      // name may already be a short slice of the prompt — too short to clear
      // the "already its own label" threshold, which made titling a no-op. The
      // transcript always holds the full first message, so it is the last
      // resort before giving up on a source.
      const titleSource = nameMap.get(parsed.sessionId)
        ?? (alreadyTitled ? undefined : await extractFirstUserPrompt(filePath))
        ?? existingSessionName;

      return {
        ...parsed,
        sessionName: normalizeSessionName(existingSessionName, 'Untitled Claude Session'),
        rawPrompt: alreadyTitled ? null : titleSource,
      };
    }

    let sessionName = nameMap.get(parsed.sessionId);
    if (!sessionName) {
      sessionName = await this.extractSessionAiTitleFromEnd(filePath, parsed.sessionId);
    }

    // The title must describe what the session is *about*, so it is built from
    // the first message. `extractSessionAiTitleFromEnd` scans backwards and
    // yields the latest prompt, which would name a session after "да, спасибо!"
    // — fine as a display name, wrong as a title source.
    const firstPrompt = await extractFirstUserPrompt(filePath);

    return {
      ...parsed,
      sessionName: normalizeSessionName(sessionName ?? firstPrompt, 'Untitled Claude Session'),
      // The raw prompt is the title source; shortening it happens after the row
      // is stored so indexing never waits on the network. See `scheduleTitle`.
      rawPrompt: firstPrompt ?? sessionName ?? null,
    };
  }

  private async extractSessionAiTitleFromEnd(
    filePath: string,
    sessionId: string
  ): Promise<string | undefined> {
    try {
      const content = await readFile(filePath, 'utf8');
      const lines = content.split(/\r?\n/);

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim();
        if (!line) {
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        const data = parsed as Record<string, unknown>;
        const eventType = typeof data.type === 'string' ? data.type : undefined;
        const eventSessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
        const aiTitle = typeof data.aiTitle === 'string' ? data.aiTitle : undefined;
        const lastPrompt = typeof data.lastPrompt === 'string' ? data.lastPrompt : undefined;
        const claudeRenamedTitle = typeof data.customTitle === 'string' ? data.customTitle : undefined;

        if (
          (eventType === 'ai-title' && eventSessionId === sessionId && aiTitle?.trim()) ||
          (eventType === 'last-prompt' && eventSessionId === sessionId && lastPrompt?.trim()) ||
          (eventType === "custom-title" && eventSessionId === sessionId && claudeRenamedTitle?.trim())
        ) {
          return aiTitle || lastPrompt || claudeRenamedTitle;
        }
      }
    } catch {
      // Ignore missing/unreadable files so sync can continue.
    }

    return undefined;
  }
}
