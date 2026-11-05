import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

/**
 * GOLDJAXE fork (реестр §4.6, §4.16): one-shot calls to a small Claude model.
 *
 * Shared by the sidebar session titles and the read-aloud summary. Both need
 * the same thing: the credentials Claude Code itself uses, a model id, and a
 * plain Messages API request that survives gateways (CLIProxyAPI among them)
 * which reject a request without extended thinking.
 *
 * Callers own their policy — prompt, token budget, temperature, timeout,
 * queueing — so this module stays a thin transport and never logs request
 * or response text.
 */

const DEFAULT_SMALL_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_API_BASE_URL = 'https://api.anthropic.com';

export type SmallModelCredentials = {
  token: string;
  baseUrl: string;
  /** Anthropic gateways accept the token either as x-api-key or as a bearer. */
  isApiKey: boolean;
};

/** Reads the `env` block of ~/.claude/settings.json, mirroring Claude Code. */
export async function loadClaudeSettingsEnv(): Promise<Record<string, unknown>> {
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    const content = await readFile(settingsPath, 'utf8');
    const settings = readObjectRecord(JSON.parse(content));
    return readObjectRecord(settings?.env) ?? {};
  } catch {
    return {};
  }
}

/**
 * Resolves API credentials in the same priority order Claude Code itself uses.
 *
 * OAuth subscription logins are deliberately not used here: that token is not
 * valid for direct Messages API calls, so a request through it would fail
 * every time instead of falling back cleanly.
 */
export async function resolveSmallModelCredentials(): Promise<SmallModelCredentials | null> {
  const settingsEnv = await loadClaudeSettingsEnv();

  const baseUrl = (
    process.env.ANTHROPIC_BASE_URL?.trim() ||
    readOptionalString(settingsEnv.ANTHROPIC_BASE_URL) ||
    DEFAULT_API_BASE_URL
  ).replace(/\/+$/, '');

  const apiKey =
    process.env.ANTHROPIC_API_KEY?.trim() || readOptionalString(settingsEnv.ANTHROPIC_API_KEY);
  if (apiKey) {
    return { token: apiKey, baseUrl, isApiKey: true };
  }

  const authToken =
    process.env.ANTHROPIC_AUTH_TOKEN?.trim() || readOptionalString(settingsEnv.ANTHROPIC_AUTH_TOKEN);
  if (authToken) {
    return { token: authToken, baseUrl, isApiKey: false };
  }

  return null;
}

/**
 * Picks the model: the caller's own override variable first (process env,
 * then Claude settings), then Claude Code's Haiku alias, then a pinned Haiku.
 */
export async function resolveSmallModel(overrideVariable: string): Promise<string> {
  const settingsEnv = await loadClaudeSettingsEnv();

  return (
    process.env[overrideVariable]?.trim() ||
    readOptionalString(settingsEnv[overrideVariable]) ||
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL?.trim() ||
    readOptionalString(settingsEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL) ||
    DEFAULT_SMALL_MODEL
  );
}

/** True for the gateway error that demands extended thinking be enabled. */
export function requiresThinking(errorBody: string): boolean {
  return /thinking.*(?:to be enabled|is required)|requires\s+`?thinking/i.test(errorBody);
}

export type SmallModelMessage = { role: 'user' | 'assistant'; content: string };

export type SmallModelRequest = {
  model: string;
  system: string;
  messages: SmallModelMessage[];
  /** Answer budget. With thinking the request adds `thinkingBudget` on top. */
  maxTokens: number;
  /** Omitted when thinking is on: the API rejects a non-default temperature then. */
  temperature?: number;
  /** Set on the retry a gateway forces; the answer still gets `maxTokens`. */
  thinkingBudget?: number;
};

export type SmallModelOutcome =
  | { status: 'ok'; text: string; stopReason: string | null }
  | { status: 'needs-thinking' }
  | { status: 'failed'; reason: string };

/**
 * POSTs one Messages API request. Never throws: network errors, timeouts,
 * aborts and non-2xx answers come back as `failed` (with a reason safe to
 * log — no request or response text), and the gateway's thinking demand as
 * `needs-thinking` so the caller can retry with a budget.
 */
export async function postSmallModelRequest(
  credentials: SmallModelCredentials,
  request: SmallModelRequest,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<SmallModelOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) controller.abort();

  const withThinking = typeof request.thinkingBudget === 'number';

  try {
    const response = await fetch(`${credentials.baseUrl}/v1/messages`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...(credentials.isApiKey
          ? { 'x-api-key': credentials.token }
          : { authorization: `Bearer ${credentials.token}` }),
      },
      body: JSON.stringify({
        model: request.model,
        system: request.system,
        messages: request.messages,
        ...(withThinking
          ? {
              max_tokens: request.maxTokens + (request.thinkingBudget as number),
              thinking: { type: 'enabled', budget_tokens: request.thinkingBudget },
            }
          : {
              max_tokens: request.maxTokens,
              ...(typeof request.temperature === 'number' ? { temperature: request.temperature } : {}),
            }),
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      if (!withThinking && response.status === 400 && requiresThinking(errorBody)) {
        return { status: 'needs-thinking' };
      }
      return { status: 'failed', reason: `HTTP ${response.status}` };
    }

    const payload = (await response.json()) as {
      content?: { type?: string; text?: string }[];
      stop_reason?: unknown;
    };
    // Thinking blocks share the response with the answer; only text counts.
    const text = (payload.content ?? [])
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join(' ');

    return {
      status: 'ok',
      text,
      stopReason: typeof payload.stop_reason === 'string' ? payload.stop_reason : null,
    };
  } catch (error) {
    const aborted = controller.signal.aborted;
    const reason = aborted
      ? (options.signal?.aborted ? 'cancelled' : 'timeout')
      : error instanceof Error ? error.message : String(error);
    return { status: 'failed', reason };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
