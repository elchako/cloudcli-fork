import type { NormalizedMessage, ResponseMetrics } from '@/shared/types.js';
import { isPlaceholderProviderModel, readObjectRecord } from '@/shared/utils.js';

type StreamSpan = {
  id: string;
  startedAt: number;
  initialTokens: number;
  latestTokens: number;
  finalUsage: boolean;
  valid: boolean;
};
const exactTokens = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

// GOLDJAXE fork (реестр §26): только основной поток текущего рана.
export class ResponseMetricsCollector {
  targetId?: string;
  anchorId?: string;
  private model?: string;
  private mixedModels = false;
  private effort?: string;
  private pendingAssistantAnchorId?: string;
  private outputTokens = 0;
  private usageValid = true;
  private awaitingResult = true;
  private hasResult = false;
  private lastResultFailed = false;
  private readonly results = new Set<string>();
  private readonly streamIds = new Set<string>();
  private span?: StreamSpan;
  private sampledOutputTokens = 0;
  private apiDurationMs = 0;

  constructor(
    private readonly monotonicNow: () => number = () => performance.now(),
    private readonly wallNow: () => number = Date.now,
  ) {}

  observeSdkMessage(value: unknown, effort?: string): NormalizedMessage['generationMetrics'] {
    this.pendingAssistantAnchorId = undefined;
    const raw = readObjectRecord(value);
    if (!raw || raw.parent_tool_use_id || raw.parentToolUseId || raw.isSidechain === true || raw.isReplay === true) return;
    if (raw.type === 'assistant' && typeof raw.uuid === 'string' && raw.uuid) this.pendingAssistantAnchorId = raw.uuid;
    this.effort = effort;

    if (raw.type === 'assistant' || raw.type === 'stream_event') {
      this.awaitingResult = true;
      const model = raw.message?.model ?? raw.event?.message?.model;
      if (typeof model === 'string' && model && !isPlaceholderProviderModel(model)) {
        this.mixedModels ||= this.model !== undefined && this.model !== model;
        this.model = model;
      }
    }
    if (raw.type === 'stream_event') return this.observeStreamEvent(raw.event);
    if (raw.type !== 'result') return;

    // result.usage — per-turn и только main loop; modelUsage — накопительный
    // счёт с subagents/compaction, поэтому никогда не участвует в этих числах.
    const key = typeof raw.uuid === 'string' && raw.uuid ? raw.uuid : undefined;
    if (key && this.results.has(key)) return;
    if (key) this.results.add(key);
    else this.usageValid = false;
    this.hasResult = true;
    this.awaitingResult = false;
    // GOLDJAXE fork (реестр §26): успешный retry заменяет исход прежнего result.
    this.lastResultFailed = raw.is_error === true || raw.subtype !== 'success';
    const tokens = readObjectRecord(raw.usage)?.output_tokens;
    if (exactTokens(tokens) && Number.isSafeInteger(this.outputTokens + tokens)) {
      this.outputTokens += tokens;
    } else {
      this.usageValid = false;
    }
    // duration_api_ms при resume/streaming input может быть cumulative, без
    // baseline его дельта недоказуема. Вместо него измеряем только spans ниже.
  }

  private observeStreamEvent(value: unknown): NormalizedMessage['generationMetrics'] {
    const event = readObjectRecord(value);
    if (!event) return;
    if (event.type === 'message_start') {
      const id = event.message?.id;
      if (typeof id !== 'string' || !id || this.streamIds.has(id)) {
        if (this.span?.id !== id) this.span = undefined;
        return;
      }
      this.streamIds.add(id);
      const tokens = event.message?.usage?.output_tokens;
      this.span = exactTokens(tokens) ? {
        id, startedAt: this.monotonicNow(), initialTokens: tokens, latestTokens: tokens,
        finalUsage: false, valid: true,
      } : undefined;
      return;
    }
    const span = this.span;
    if (!span) return;
    if (event.type === 'message_delta') {
      const tokens = event.usage?.output_tokens;
      if (!exactTokens(tokens) || tokens < span.latestTokens) {
        span.valid = false;
        return;
      }
      const changed = tokens > span.latestTokens;
      span.latestTokens = tokens;
      span.finalUsage = typeof event.delta?.stop_reason === 'string' && Boolean(event.delta.stop_reason);
      const elapsed = this.monotonicNow() - span.startedAt;
      // Только новый reported counter этого же API-вызова. SDK обычно сообщает
      // его лишь к концу потока: это редкий sample, не постоянная оценка по SSE.
      if (span.valid && changed && elapsed > 0) {
        return { tokensPerSecond: (tokens - span.initialTokens) * 1000 / elapsed, sampledAt: this.wallNow() };
      }
    } else if (event.type === 'message_stop') {
      const elapsed = this.monotonicNow() - span.startedAt;
      this.span = undefined;
      if (span.valid && span.finalUsage && elapsed > 0) {
        this.sampledOutputTokens += span.latestTokens - span.initialTokens;
        this.apiDurationMs += elapsed;
      }
    }
  }

  observeMessage(message: NormalizedMessage): void {
    // GOLDJAXE fork (реестр §26): error-кадр может быть восстановимым; исход
    // определяют terminal complete и последний SDK result, не сам факт error.
    if (message.kind === 'error') this.awaitingResult = true;
    if (message.kind !== 'text' || message.role !== 'assistant' || !message.content?.trim()
      || message.parentToolUseId || message.compact || message.contextCleared
      || message.isCompactSummary || message.isLocalCommandStdout) return;
    // UUID берётся из того же raw assistant, не из transcriptAnchorId: тот
    // по контракту upstream только для редактирования пользовательских строк.
    // Новая строка без доказанной связи обнуляет цель, fallback назад запрещён.
    const anchor = this.pendingAssistantAnchorId;
    const belongsToAnchor = anchor && (message.id === anchor || (message.id.startsWith(`${anchor}_`)
      && /^\d+$/.test(message.id.slice(anchor.length + 1))));
    this.anchorId = belongsToAnchor ? anchor : undefined;
    this.targetId = belongsToAnchor ? message.id : undefined;
  }

  finish(runId: string, startedAt: number, completedAt: number, terminal: NormalizedMessage): ResponseMetrics {
    const outcome = terminal.aborted === true ? 'stopped'
      : this.lastResultFailed || terminal.success === false || terminal.exitCode !== 0 ? 'failed' : 'completed';
    return {
      runId,
      startedAt,
      completedAt,
      durationMs: Math.max(0, completedAt - startedAt),
      outcome,
      ...(outcome !== 'stopped' && this.hasResult && this.usageValid && !this.awaitingResult
        ? { outputTokens: this.outputTokens } : {}),
      // Скорость наблюдаемого стрима, НЕ decoding TPS: отсчёт начинается после
      // прихода message_start, в числителе только приращения в полных spans.
      // GOLDJAXE fork (реестр §26): при fallback A→B нельзя подписывать смесь
      // интервалов последней моделью; свежий live sample всё ещё относится к одному span.
      ...(this.apiDurationMs > 0 && !this.mixedModels ? {
        sampledOutputTokens: this.sampledOutputTokens,
        apiDurationMs: this.apiDurationMs,
        tokensPerSecond: this.sampledOutputTokens * 1000 / this.apiDurationMs,
      } : {}),
      ...(this.model ? { model: this.model } : {}),
      ...(this.effort ? { effort: this.effort } : {}),
    };
  }
}
