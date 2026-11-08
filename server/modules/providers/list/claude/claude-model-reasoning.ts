import type { ProviderModelOption } from '@/shared/types.js';
import { decodeCliProxyModelId } from '@/modules/providers/list/claude/claude-api-models.js';

type Reasoning = Pick<ProviderModelOption, 'effort' | 'reasoningStatus'>;

// GOLDJAXE fork (реестр §22.2): это только подтверждённые метаданные, НЕ каталог
// доступности. Модель появляется исключительно из API. Источник уровней:
// CLIProxyAPI v8.0.58 internal/registry/models/models.json; не Codex-client шаблоны.
// https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.58/internal/registry/models/models.json
const THREE_LEVEL_MODELS = new Set([
  'gemini-4-argon-high', 'gemini-3.8-flash-high',
  'claude-opus-5-5-high', 'claude-sonnet-5-5-high',
]);
const FIVE_LEVEL_MODELS = new Set([
  'gpt-6-astra', 'gpt-6-sol', 'gpt-6-chat-thinking', 'gpt-6.1-sol',
  'gpt-6.1-terra', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra',
]);

export function knownGatewayModelReasoning(model: string): Reasoning | null {
  const id = decodeCliProxyModelId(model);
  if (id.startsWith('gpt-image-')) return { reasoningStatus: 'unsupported' };
  const levels = THREE_LEVEL_MODELS.has(id) ? ['low', 'medium', 'high']
    : FIVE_LEVEL_MODELS.has(id) ? ['low', 'medium', 'high', 'xhigh', 'max']
      : id === 'codex-auto-review' ? ['low', 'medium', 'high', 'xhigh'] : null;
  if (!levels) return null;
  // Реальный default шлюз не сообщает: не наследуем синтетический medium/low.
  return { effort: { transport: 'model-suffix', values: levels.map(value => ({ value })) } };
}
