import {
  isAdaptiveThinkingModel,
  postSmallModelRequest,
  resolveSmallModelCredentials,
  type SmallModelCredentials,
} from '@/shared/small-model.js';
import { decodeCliProxyModelId } from '@/modules/providers/list/claude/claude-api-models.js';
import {
  sessionTitleModelsService,
  type SessionTitleModelRequest,
} from '@/modules/providers/services/session-title-models.service.js';

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
const THINKING_ANSWER_TOKENS = 256;

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

/**
 * Sampling temperature for a manual regenerate.
 *
 * Titling runs at temperature 0 so a session gets a stable name. For the
 * "regenerate" button that is exactly wrong: the model returned the very same
 * title every time, so pressing it looked like nothing happened.
 */
const REGENERATE_TEMPERATURE = 1;

/** Tells the model which title the user just rejected. */
function buildSystemPrompt(previousTitle: string | undefined): string {
  if (!previousTitle) {
    return TITLE_SYSTEM_PROMPT;
  }

  return [
    TITLE_SYSTEM_PROMPT,
    `- Прежний заголовок «${previousTitle}» не подошёл: предложи другой, сформулированный иначе.`,
  ].join('\n');
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

type TitleRequestOutcome =
  | { status: 'ok'; title: string | null }
  | { status: 'needs-thinking' }
  | { status: 'failed' };

async function postTitleRequest(
  credentials: SmallModelCredentials,
  model: SessionTitleModelRequest,
  prompt: string,
  withThinking: boolean,
  previousTitle: string | undefined,
): Promise<TitleRequestOutcome> {
  // GOLDJAXE fork (реестр §4.9-тер): минимальный подтверждённый effort уже
  // выбран helper'ом; retry добавляет только необходимые thinking-параметры.
  const adaptiveThinking = model.adaptiveThinking
    || (withThinking && isAdaptiveThinkingModel(decodeCliProxyModelId(model.model)));
  const outcome = await postSmallModelRequest(
    credentials,
    {
      ...model,
      system: buildSystemPrompt(previousTitle),
      messages: [{ role: 'user', content: prompt.slice(0, MAX_PROMPT_CHARS) }],
      ...(adaptiveThinking
        ? { maxTokens: THINKING_BUDGET_TOKENS, adaptiveThinking: true }
        : withThinking
          ? { maxTokens: THINKING_ANSWER_TOKENS, thinkingBudget: THINKING_BUDGET_TOKENS }
          : { maxTokens: 64, temperature: previousTitle ? REGENERATE_TEMPERATURE : 0 }),
    },
    { timeoutMs: REQUEST_TIMEOUT_MS },
  );

  if (outcome.status === 'needs-thinking') {
    return outcome;
  }
  if (outcome.status === 'failed') {
    console.warn(`Не удалось сгенерировать название сеанса (${outcome.reason})`);
    return { status: 'failed' };
  }
  return { status: 'ok', title: outcome.stopReason !== 'max_tokens' && outcome.text ? sanitizeModelTitle(outcome.text) : null };
}

async function requestModelTitle(
  prompt: string,
  previousTitle: string | undefined,
  userId: number | undefined,
): Promise<string | null> {
  return enqueueTitleRequest(async () => {
    try {
      const credentials = await resolveSmallModelCredentials();
      if (!credentials) return null;
      const candidates = await sessionTitleModelsService.resolveCandidates(userId);
      // GOLDJAXE fork (реестр §4.9-тер): основная → резервная, каждый ID один
      // раз в цепочке. Единственное исключение — совместимый thinking retry.
      const attempted = new Set<string>();
      for (const model of candidates) {
        if (attempted.has(model.model)) continue;
        attempted.add(model.model);
        const first = await postTitleRequest(credentials, model, prompt, false, previousTitle);
        if (first.status === 'ok' && first.title) return first.title;
        if (first.status === 'needs-thinking') {
          const retry = await postTitleRequest(credentials, model, prompt, true, previousTitle);
          if (retry.status === 'ok' && retry.title) return retry.title;
        }
      }
    } catch {
      // Ошибка БД/каталога тоже не должна ломать индексацию или раскрывать настройки.
      console.warn('Не удалось получить настройки модели названий сеансов');
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

export type GenerateSessionTitleOptions = {
  /**
   * The title the user is replacing (manual regenerate). The model is told to
   * avoid it and sampled with a non-zero temperature, so a regenerate yields a
   * new label instead of the same deterministic one.
   */
  previousTitle?: string;
  /** GOLDJAXE fork (реестр §4.9-тер): ручная генерация от имени пользователя. */
  userId?: number;
};

/**
 * Turns the first user prompt of a session into a sidebar title.
 *
 * Never throws: on any failure it returns the trimmed prompt with
 * `generated: false`.
 */
export async function generateSessionTitle(
  prompt: string,
  options: GenerateSessionTitleOptions = {},
): Promise<GeneratedSessionTitle | null> {
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

  const previousTitle = options.previousTitle?.replace(/\s+/g, ' ').trim() || undefined;
  const modelTitle = await requestModelTitle(normalizedPrompt, previousTitle, options.userId);
  if (!modelTitle) {
    return { title: fallback, fullTitle, generated: false };
  }

  return { title: modelTitle, fullTitle: normalizedPrompt, generated: true };
}
