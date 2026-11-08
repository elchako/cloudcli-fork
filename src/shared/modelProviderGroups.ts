import type { ProviderModelOption } from '@/shared/types';

export type ModelProviderGroup = {
  key: string;
  name: string;
  models: ProviderModelOption[];
};

type GroupLabels = { default: string; unassigned: string };

const PROVIDER_NAMES: Record<string, string> = {
  openai: 'OpenAI',
  antigravity: 'Antigravity',
  anthropic: 'Anthropic',
  google: 'Google',
};

/** GOLDJAXE fork (реестр §22.1): группы только по owned_by API, не по имени модели.
 * CLI-провайдер выбора не меняется. Порядок внутри групп и исходные ID сохранены.
 * Без метаданных оставляем прежний плоский список, не угадывая провайдера.
 */
export function groupModelsByCatalogProvider(
  models: ProviderModelOption[],
  labels: GroupLabels,
): ModelProviderGroup[] {
  if (!models.some((model) => model.catalogProvider)) {
    return [{ key: 'catalog', name: '', models }];
  }
  const groups = new Map<string, ModelProviderGroup>();
  for (const model of models) {
    const owner = model.catalogProvider;
    const key = owner ? `provider:${owner}` : model.value === 'default' ? 'default' : 'unassigned';
    let group = groups.get(key);
    if (!group) {
      const name = owner
        ? (Object.prototype.hasOwnProperty.call(PROVIDER_NAMES, owner) ? PROVIDER_NAMES[owner] : owner)
        : key === 'default' ? labels.default : labels.unassigned;
      group = { key, name, models: [] };
      groups.set(key, group);
    }
    group.models.push(model);
  }
  return [...groups.values()];
}
