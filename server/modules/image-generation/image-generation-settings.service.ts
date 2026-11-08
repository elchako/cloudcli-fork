import { userSettingsDb } from '@/modules/database/index.js';
import { claudeApiModelCatalog, decodeCliProxyModelId } from '@/modules/providers/model-catalog.js';
import { loadClaudeSettingsEnv, type ApiModel } from '@/shared/small-model.js';
import { AppError, readObjectRecord, readOptionalString } from '@/shared/utils.js';

import {
  IMAGE_PROFILES, IMAGE_QUALITIES,
  type ImageGenerationSettings, type ImageProfile, type ImageQuality,
} from './image-generation.config.js';

// GOLDJAXE fork (реестр §13.3): не-секретная настройка аккаунта, без localStorage-синхронизации.
export const IMAGE_GENERATION_SETTINGS_KEY = 'image-generation';
export const DEFAULT_IMAGE_MODEL = 'gpt-image-2.6';

type Dependencies = {
  readSettings(userId: number): Record<string, unknown>;
  writeSettings(userId: number, patch: Record<string, unknown>): unknown;
  getCatalog(force?: boolean): Promise<{ models: ApiModel[] | null }>;
  resolveDefaultModel(): Promise<string>;
};

/** Пока только семейство GPT Image: наличие другого image-ID не обещает поддержку /images. */
export function imageCatalogModels(models: ApiModel[] | null): ApiModel[] | null {
  if (models === null) return null;
  const unique = new Map<string, ApiModel>();
  for (const model of models) {
    const id = decodeCliProxyModelId(model.id);
    if (/^gpt-image(?:-[a-z0-9._-]+)?$/i.test(id) && !unique.has(id)) {
      unique.set(id, { ...model, id, label: model.label === model.id ? id : model.label });
    }
  }
  return [...unique.values()];
}

export function defaultImageSettings(model: string): ImageGenerationSettings {
  return {
    defaultProfile: 'standard',
    profiles: {
      draft: { model, quality: 'low' },
      standard: { model, quality: 'auto' },
      final: { model, quality: 'high' },
    },
  };
}

function parseSettings(input: unknown): ImageGenerationSettings {
  const record = readObjectRecord(input);
  const profiles = readObjectRecord(record?.profiles);
  if (!IMAGE_PROFILES.includes(record?.defaultProfile as ImageProfile) || !profiles) {
    throw new AppError('Выберите режим по умолчанию и настройте три профиля', {
      code: 'IMAGE_SETTINGS_INVALID', statusCode: 400,
    });
  }
  const result = defaultImageSettings('');
  result.defaultProfile = record!.defaultProfile as ImageProfile;
  for (const id of IMAGE_PROFILES) {
    const profile = readObjectRecord(profiles[id]);
    const model = readOptionalString(profile?.model);
    if (!model || model.length > 256 || !/^gpt-image(?:-[a-z0-9._-]+)?$/i.test(model)
      || !IMAGE_QUALITIES.includes(profile?.quality as ImageQuality)) {
      throw new AppError('Для каждого режима нужны модель GPT Image и качество', {
        code: 'IMAGE_SETTINGS_INVALID', statusCode: 400,
      });
    }
    result.profiles[id] = { model, quality: profile!.quality as typeof IMAGE_QUALITIES[number] };
  }
  return result;
}

export function createImageGenerationSettingsService(dependencies: Dependencies) {
  async function selection(userId?: number) {
    const saved = userId === undefined ? undefined : dependencies.readSettings(userId)[IMAGE_GENERATION_SETTINGS_KEY];
    // Повреждённая явная настройка — ошибка, а не скрытый выбор другой платной модели.
    return saved === undefined ? defaultImageSettings(await dependencies.resolveDefaultModel()) : parseSettings(saved);
  }

  return {
    async getStatus(userId: number, refresh = false) {
      const settings = await selection(userId);
      const { models } = await dependencies.getCatalog(refresh);
      return { settings, models: imageCatalogModels(models) };
    },

    async save(userId: number, input: unknown): Promise<ImageGenerationSettings> {
      const next = parseSettings(input);
      const previous = await selection(userId);
      const { models: raw } = await dependencies.getCatalog();
      const models = imageCatalogModels(raw);
      for (const id of IMAGE_PROFILES) {
        const model = next.profiles[id].model;
        if (!models?.some((entry) => entry.id === model) && previous.profiles[id].model !== model) {
          throw new AppError('Модель отсутствует в API-каталоге. Обновите список и выберите другую.', {
            code: models === null ? 'IMAGE_CATALOG_UNAVAILABLE' : 'IMAGE_MODEL_UNAVAILABLE', statusCode: 400,
          });
        }
      }
      dependencies.writeSettings(userId, { [IMAGE_GENERATION_SETTINGS_KEY]: next });
      return next;
    },

    async resolve(userId?: number, requestedProfile?: ImageProfile) {
      const settings = await selection(userId);
      const profile = requestedProfile ?? settings.defaultProfile;
      if (!IMAGE_PROFILES.includes(profile)) {
        throw new AppError('Неизвестный режим генерации картинки', { code: 'IMAGE_PROFILE_INVALID', statusCode: 400 });
      }
      const selected = settings.profiles[profile];
      const { models } = await dependencies.getCatalog();
      if (models !== null && !imageCatalogModels(models)?.some((model) => model.id === selected.model)) {
        throw new AppError(`Модель ${selected.model} для режима ${profile} недоступна. Выберите другую в настройках.`, {
          code: 'IMAGE_MODEL_UNAVAILABLE', statusCode: 400,
        });
      }
      return { profile, ...selected };
    },
  };
}

export const imageGenerationSettingsService = createImageGenerationSettingsService({
  readSettings: (userId) => userSettingsDb.getSettings(userId),
  writeSettings: (userId, patch) => userSettingsDb.updateSettings(userId, patch, true),
  getCatalog: (force) => claudeApiModelCatalog.get(force),
  resolveDefaultModel: async () => {
    const settings = await loadClaudeSettingsEnv();
    return process.env.CLOUDCLI_IMAGE_MODEL?.trim() || readOptionalString(settings.CLOUDCLI_IMAGE_MODEL) || DEFAULT_IMAGE_MODEL;
  },
});
