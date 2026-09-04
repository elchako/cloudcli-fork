import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

/**
 * Generates short, scannable sidebar titles for sessions.
 *
 * Sidebar rows are narrow: a raw first prompt gets truncated after a few words,
 * so every row of a long working day reads the same ("продолжаем дорабатыв…").
 * A small model rewrites the prompt into a "<subject> — <action>" label whose
 * first two words already identify the session, and the untruncated prompt is
 * kept alongside it for the hover tooltip.
 *
 * Every failure mode (no credentials, gateway down, timeout, junk output) falls
 * back to the previous behaviour — the trimmed raw prompt — because a session
 * must never end up nameless just because the title model was unavailable.
 */

/** Sidebar rows fit roughly this much text before truncating. */
const MAX_TITLE_LENGTH = 48;

/** Prompt text beyond this adds no signal but costs latency. */
const MAX_PROMPT_CHARS = 2000;

const REQUEST_TIMEOUT_MS = 12000;

/**
 * Budget for the retry that some gateways force by rejecting plain requests
 * with a `thinking`-required error. Small on purpose: the model only has to
 * produce one short line, and `max_tokens` must stay above the budget.
 */
const THINKING_BUDGET_TOKENS = 1024;
const THINKING_MAX_TOKENS = THINKING_BUDGET_TOKENS + 256;

/**
 * Serializes title requests.
 *
 * A first-run index walks every transcript on disk at once; firing one request
 * per session in parallel makes gateways drop connections outright (observed as
 * `fetch failed` on a 121-session import), and each failure silently costs that
 * session its title. Titles are never on a user-visible critical path, so they
 * queue instead.
 */
let titleRequestQueue: Promise<unknown> = Promise.resolve();

function enqueueTitleRequest<T>(task: () => Promise<T>): Promise<T> {
  const result = titleRequestQueue.then(task, task);
  // Keep the chain alive regardless of individual outcomes.
  titleRequestQueue = result.catch(() => undefined);
  return result;
}

const DEFAULT_TITLE_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_API_BASE_URL = 'https://api.anthropic.com';

/**
 * The prompt must produce a title for ANY first message, not just well-formed
 * task requests.
 *
 * The original version demanded that the first two words name a project,
 * domain, service or issue key. Dictated or exploratory prompts often contain
 * none of those, and facing an impossible requirement the model would answer
 * with an explanation instead of a title — which `sanitizeModelTitle` then
 * rejects, silently falling back to the truncated raw prompt. That is why
 * titling worked "sometimes". The subject rule is now a preference order with
 * a topic-based fallback, plus an explicit "always answer" instruction.
 */
const TITLE_SYSTEM_PROMPT = [
  'Ты формируешь короткий заголовок рабочего сеанса для боковой панели.',
  '',
  'Правила:',
  '- Отвечай ТОЛЬКО заголовком, без кавычек, пояснений и точки в конце.',
  `- Не длиннее ${MAX_TITLE_LENGTH} символов.`,
  '- Заголовок обязателен всегда. Любой запрос можно озаглавить по его теме.',
  '  Никогда не отказывайся и не проси уточнений.',
  '- Предмет заголовка выбирай по первому подходящему пункту:',
  '  1) проект, домен, сервис, репозиторий, файл или номер задачи, если он назван;',
  '  2) иначе — главная тема запроса (что обсуждают или что надо сделать).',
  '- Формат «<предмет> — <действие>» предпочтителен, например',
  '  «goldjaxe-wiki — правки боковой панели». Если действие не выражено,',
  '  достаточно назвать тему без тире.',
  '- Сохраняй имена собственные как есть (домены, GOL-123, имена репозиториев, названия команд).',
  '- Запрос может быть надиктован голосом: игнорируй оговорки, повторы и',
  '  самоперебивания, бери суть.',
  '- Пиши на языке запроса.',
  '- Никаких вводных вроде «Запрос», «Задача», «Пользователь просит».',
].join('\n');

type TitleCredentials = {
  token: string;
  baseUrl: string;
  /** Anthropic gateways accept the token either as x-api-key or as a bearer. */
  isApiKey: boolean;
};

/** Reads the `env` block of ~/.claude/settings.json, mirroring Claude Code. */
async function loadClaudeSettingsEnv(): Promise<Record<string, unknown>> {
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
 * valid for direct Messages API calls, so a session titled through it would
 * fail on every request instead of falling back cleanly.
 */
async function resolveCredentials(): Promise<TitleCredentials | null> {
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

async function resolveTitleModel(): Promise<string> {
  const settingsEnv = await loadClaudeSettingsEnv();

  return (
    process.env.CLOUDCLI_SESSION_TITLE_MODEL?.trim() ||
    readOptionalString(settingsEnv.CLOUDCLI_SESSION_TITLE_MODEL) ||
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL?.trim() ||
    readOptionalString(settingsEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL) ||
    DEFAULT_TITLE_MODEL
  );
}

/** True unless the operator explicitly turned AI titles off. */
export function isAiTitleGenerationEnabled(): boolean {
  const flag = process.env.CLOUDCLI_SESSION_TITLES?.trim().toLowerCase();
  return flag !== 'off' && flag !== '0' && flag !== 'false';
}

/**
 * Trims a raw prompt down to a sidebar-sized label without a model.
 *
 * Used both as the fallback when titling is unavailable and as a guard against
 * a model that answers with a sentence instead of a title.
 */
export function buildFallbackTitle(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  if (normalized.length <= MAX_TITLE_LENGTH) {
    return normalized;
  }

  // Prefer cutting on a word boundary so the label does not end mid-word.
  const hardCut = normalized.slice(0, MAX_TITLE_LENGTH);
  const lastSpace = hardCut.lastIndexOf(' ');
  const cut = lastSpace > MAX_TITLE_LENGTH * 0.6 ? hardCut.slice(0, lastSpace) : hardCut;

  return `${cut.trimEnd()}…`;
}

/**
 * Strips the decorations small models like to add around a bare title.
 * Returns null when the answer does not look like a title at all.
 */
function sanitizeModelTitle(rawTitle: string): string | null {
  let title = rawTitle.replace(/\s+/g, ' ').trim();

  // Models occasionally answer with several lines; the first one is the title.
  const firstLine = rawTitle.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (firstLine) {
    title = firstLine.replace(/\s+/g, ' ').trim();
  }

  title = title
    .replace(/^["'«»`*_\s]+/, '')
    .replace(/["'«»`*_\s]+$/, '')
    .replace(/^(?:заголовок|название|title)\s*[:—-]\s*/i, '')
    .replace(/[.。]+$/, '')
    .trim();

  if (!title) {
    return null;
  }

  // A refusal or an explanation is longer than any title we asked for.
  if (title.length > MAX_TITLE_LENGTH * 2) {
    return null;
  }

  return title.length > MAX_TITLE_LENGTH ? buildFallbackTitle(title) : title;
}

/** True for the gateway error that demands extended thinking be enabled. */
function requiresThinking(errorBody: string): boolean {
  return /thinking.*(?:to be enabled|is required)|requires\s+`?thinking/i.test(errorBody);
}

type TitleRequestOutcome =
  | { status: 'ok'; title: string | null }
  | { status: 'needs-thinking' }
  | { status: 'failed' };

async function postTitleRequest(
  credentials: TitleCredentials,
  model: string,
  prompt: string,
  withThinking: boolean,
): Promise<TitleRequestOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

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
        model,
        system: TITLE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt.slice(0, MAX_PROMPT_CHARS) }],
        ...(withThinking
          ? {
              // Thinking rejects a non-default temperature, so it is omitted here.
              max_tokens: THINKING_MAX_TOKENS,
              thinking: { type: 'enabled', budget_tokens: THINKING_BUDGET_TOKENS },
            }
          : { max_tokens: 64, temperature: 0 }),
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      if (!withThinking && response.status === 400 && requiresThinking(errorBody)) {
        return { status: 'needs-thinking' };
      }

      console.warn(`Session title model returned HTTP ${response.status}; keeping the raw prompt`);
      return { status: 'failed' };
    }

    const payload = (await response.json()) as {
      content?: { type?: string; text?: string }[];
    };
    // Thinking blocks share the response with the answer; only text counts.
    const text = payload.content
      ?.filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join(' ');

    return { status: 'ok', title: text ? sanitizeModelTitle(text) : null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`Session title generation failed (${reason}); keeping the raw prompt`);
    return { status: 'failed' };
  } finally {
    clearTimeout(timeout);
  }
}

async function requestModelTitle(prompt: string): Promise<string | null> {
  const credentials = await resolveCredentials();
  if (!credentials) {
    return null;
  }

  const model = await resolveTitleModel();

  return enqueueTitleRequest(async () => {
    const firstAttempt = await postTitleRequest(credentials, model, prompt, false);
    if (firstAttempt.status === 'ok') {
      return firstAttempt.title;
    }

    // Some gateways (CLIProxyAPI among them) reject plain requests and require
    // extended thinking; retrying with it turns that hard failure into a title.
    if (firstAttempt.status === 'needs-thinking') {
      const retry = await postTitleRequest(credentials, model, prompt, true);
      return retry.status === 'ok' ? retry.title : null;
    }

    return null;
  });
}

export type GeneratedSessionTitle = {
  /** Short label shown in the sidebar row. */
  title: string;
  /**
   * The untruncated prompt when it differs from `title`, otherwise null so the
   * tooltip does not repeat the visible text.
   */
  fullTitle: string | null;
  /** False when the fallback was used, so callers can retry later. */
  generated: boolean;
};

/**
 * Turns the first user prompt of a session into a sidebar title.
 *
 * Never throws: on any failure it returns the trimmed prompt with
 * `generated: false`.
 */
export async function generateSessionTitle(prompt: string): Promise<GeneratedSessionTitle | null> {
  const normalizedPrompt = prompt.replace(/\s+/g, ' ').trim();
  if (!normalizedPrompt) {
    return null;
  }

  const fallback = buildFallbackTitle(normalizedPrompt);
  const fullTitle = normalizedPrompt === fallback ? null : normalizedPrompt;

  // Short prompts are already their own best label — spend nothing on them.
  if (!isAiTitleGenerationEnabled() || normalizedPrompt.length <= MAX_TITLE_LENGTH) {
    return { title: fallback, fullTitle, generated: false };
  }

  const modelTitle = await requestModelTitle(normalizedPrompt);
  if (!modelTitle) {
    return { title: fallback, fullTitle, generated: false };
  }

  return { title: modelTitle, fullTitle: normalizedPrompt, generated: true };
}
