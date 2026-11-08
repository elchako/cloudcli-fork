import {
  decodeCliProxyModelId,
  findClaudeModelOption,
  knownGatewayModelReasoning,
  withGatewayEffortSuffix,
} from '@/modules/providers/model-catalog.js';
import { isAdaptiveThinkingModel } from '@/shared/small-model.js';
import type { ApiModel, SmallModelRequest } from '@/shared/small-model.js';
import type { ProviderModelOption } from '@/shared/types.js';

// GOLDJAXE fork (реестр §4.9-тер, §4.16-тер): единая политика текстовых фоновых задач.
export type BackgroundModelRequest = Pick<SmallModelRequest, 'model' | 'effort' | 'adaptiveThinking'>;

/** API не сообщает modality. Исключаем известные генераторы, а не дорогие/медленные модели. */
export function isBackgroundTextModel(model: Pick<ApiModel, 'id' | 'label'>): boolean {
  const name = `${decodeCliProxyModelId(model.id)} ${model.label}`;
  return model.id.length > 0 && model.id.length <= 256 && !/[\s\u0000-\u001f\u007f]/u.test(model.id)
    && !/(?:image|imagen|dall[._ -]?e\b|flux|stable[._ -]?diffusion|sdxl|nano[._ -]?banana|midjourney)/i.test(name)
    // Известные модели отдельных audio/embedding/rerank endpoint, не chat-модели
    // с произвольным словом «audio» или «voice» в имени.
    && !/(?:^|[ /])(?:whisper|tts|text-embedding|embedding|embed|rerank|reranker)(?:[-. ]|$)/i.test(name)
    && !/(?:^|[ /])gpt-[\w.-]*-(?:tts|transcribe)(?:[-. ]|$)/i.test(name);
}

/** Только для модели текущего каталога. Явные capabilities важнее известных метаданных;
 * supported_reasoning_levels из клиентских шаблонов здесь вообще не используются. */
export function buildBackgroundModelRequest(model: string, catalog: ApiModel[] | null = null): BackgroundModelRequest {
  const entry = catalog?.find((item) => item.id === model);
  if (!entry || entry.reasoningStatus) return { model };
  const canonical = decodeCliProxyModelId(model);
  const known = findClaudeModelOption(model) || findClaudeModelOption(canonical)
    || findClaudeModelOption(`${canonical}[1m]`);
  const gatewayKnown = entry.catalogProvider === 'antigravity' || entry.catalogProvider === 'openai'
    ? knownGatewayModelReasoning(canonical) : null;
  const effortMetadata = entry.effort ? {
    ...entry.effort,
    ...(entry.effort.transport || !gatewayKnown?.effort?.transport ? {}
      : { transport: gatewayKnown.effort.transport }),
  } : gatewayKnown?.effort ?? known?.effort;
  const values = effortMetadata?.values.filter((option) => option.value !== 'ultracode') ?? [];
  // Сравниваем только реально объявленные уровни. Это порядок усилия, а не
  // выдуманная capability: ни одного отсутствующего значения в запрос не добавляем.
  const effort = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    .find((level) => values.some((option) => option.value === level)) ?? values[0]?.value;
  if (!effort || !effortMetadata) return { model };
  // Не угадываем транспорт нового GPT по одному префиксу. Старые подтверждённые
  // записи каталога без transport сохраняют совместимость с withGatewayEffortSuffix.
  const transport = effortMetadata.transport
    ?? (isAdaptiveThinkingModel(canonical) ? 'sdk'
      : !entry.effort && known && canonical.startsWith('gpt-') ? 'model-suffix' : undefined);
  if (!transport) return { model };
  const option: ProviderModelOption = { value: model, label: entry.label, effort: { ...effortMetadata, transport } };
  const gatewayModel = withGatewayEffortSuffix(model, effort, { OPTIONS: [option], DEFAULT: model });
  if (transport === 'model-suffix') return { model: gatewayModel };
  return { model, effort, ...(isAdaptiveThinkingModel(canonical) ? { adaptiveThinking: true } : {}) };
}

export function isClaudeBackgroundModel(model: string): boolean {
  return /(?:^|[/.])claude-(?:haiku|sonnet|opus|fable)-/.test(decodeCliProxyModelId(model));
}

/** Совместимость со старым шлюзом: повтор thinking разрешён только настоящему Claude. */
export function backgroundThinkingRetry(request: SmallModelRequest): SmallModelRequest | null {
  const canonical = decodeCliProxyModelId(request.model);
  if (request.adaptiveThinking || request.thinkingBudget || !isClaudeBackgroundModel(request.model)) {
    return null;
  }
  return isAdaptiveThinkingModel(canonical)
    ? { ...request, adaptiveThinking: true }
    : { ...request, thinkingBudget: 1024 };
}
