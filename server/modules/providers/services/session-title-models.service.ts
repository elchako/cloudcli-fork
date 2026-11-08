import { userDb, userSettingsDb } from '@/modules/database/index.js';
import { claudeApiModelCatalog } from '@/modules/providers/list/claude/claude-api-models.js';
import {
  buildBackgroundModelRequest,
  isBackgroundTextModel,
} from '@/shared/background-models.js';
import type { BackgroundModelRequest } from '@/shared/background-models.js';
import { resolveSmallModel } from '@/shared/small-model.js';
import type { ApiModel } from '@/shared/small-model.js';
import { AppError } from '@/shared/utils.js';

// GOLDJAXE fork (реестр §4.9-тер): отдельный не-секретный ключ, не user_preferences
// и не localStorage/userSettingsSync. Заголовки не зависят от модели сводки.
export const SESSION_TITLE_MODELS_KEY = 'session-title-models';

export type SessionTitleModelSettings = {
  primaryModel: string;
  fallbackModel: string;
};

export type SessionTitleModelRequest = BackgroundModelRequest;
// Совместимость существующих импортов и тестов (§4.9-тер).
export { buildBackgroundModelRequest as buildSessionTitleModelRequest, isBackgroundTextModel as isSessionTitleTextModel };
const isSessionTitleTextModel = isBackgroundTextModel;

type Dependencies = {
  readSettings(userId: number): Record<string, unknown>;
  writeSettings(userId: number, patch: Record<string, unknown>): unknown;
  getBackgroundUserId(): number | undefined;
  getCatalog(): Promise<{ models: ApiModel[] | null }>;
  resolveLegacyModel(): Promise<string>;
};

const EMPTY_SETTINGS: SessionTitleModelSettings = { primaryModel: '', fallbackModel: '' };

function modelId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isValidModelId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/[\s\u0000-\u001f\u007f]/u.test(value);
}

export function createSessionTitleModelsService(dependencies: Dependencies) {
  function readSelection(userId?: number): SessionTitleModelSettings | null {
    const id = userId ?? dependencies.getBackgroundUserId();
    if (id === undefined) return null;
    const value = dependencies.readSettings(id)[SESSION_TITLE_MODELS_KEY];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return { primaryModel: modelId(record.primaryModel), fallbackModel: modelId(record.fallbackModel) };
  }

  async function load(userId?: number) {
    const selection = readSelection(userId);
    const catalog = await dependencies.getCatalog();
    const models = catalog.models?.filter(isSessionTitleTextModel) ?? null;
    // Совместимость до настройки пары: legacy разрешён только при подтверждении
    // текущим API-каталогом. Ни первой, ни «дешёвой» модели мы не выбираем.
    const legacy = selection === null ? await dependencies.resolveLegacyModel() : '';
    const legacyModel = legacy && models?.some((model) => model.id === legacy) ? legacy : null;
    return { settings: selection ?? { ...EMPTY_SETTINGS }, models, legacyModel };
  }

  return {
    getStatus: load,

    async save(userId: number, input: unknown): Promise<SessionTitleModelSettings> {
      const payload = input && typeof input === 'object' && !Array.isArray(input)
        ? input as Record<string, unknown> : {};
      const next = { primaryModel: modelId(payload.primaryModel), fallbackModel: modelId(payload.fallbackModel) };
      if (!isValidModelId(next.primaryModel) || !isValidModelId(next.fallbackModel)) {
        throw new AppError('Выберите основную и резервную модели', {
          code: 'SESSION_TITLE_MODELS_REQUIRED', statusCode: 400,
        });
      }
      if (next.primaryModel === next.fallbackModel) {
        throw new AppError('Основная и резервная модели должны различаться', {
          code: 'SESSION_TITLE_MODELS_DUPLICATE', statusCode: 400,
        });
      }
      const { models } = await dependencies.getCatalog();
      const previous = readSelection(userId);
      for (const field of ['primaryModel', 'fallbackModel'] as const) {
        const id = next[field];
        if (!isSessionTitleTextModel({ id, label: id })) {
          throw new AppError('Для названий нужна текстовая модель', {
            code: 'SESSION_TITLE_MODEL_NOT_TEXT', statusCode: 400,
          });
        }
        const listed = models?.find((model) => model.id === id);
        if (listed && !isSessionTitleTextModel(listed)) {
          throw new AppError('Для названий нужна текстовая модель', {
            code: 'SESSION_TITLE_MODEL_NOT_TEXT', statusCode: 400,
          });
        }
        // Сохранённый ID не теряем при временном исчезновении: можно заменить
        // только резервный, не переписывая намерение пользователя для основного.
        if (!listed && previous?.[field] !== id) {
          throw new AppError('Модель отсутствует в подключённом API-каталоге', {
            code: models === null ? 'SESSION_TITLE_CATALOG_UNAVAILABLE' : 'SESSION_TITLE_MODEL_UNAVAILABLE',
            statusCode: 400,
          });
        }
      }
      dependencies.writeSettings(userId, { [SESSION_TITLE_MODELS_KEY]: next });
      return next;
    },

    async resolveCandidates(userId?: number): Promise<SessionTitleModelRequest[]> {
      const { settings, models, legacyModel } = await load(userId);
      const ids = [...new Set([settings.primaryModel, settings.fallbackModel, legacyModel ?? ''])];
      return ids.filter((id) => isSessionTitleTextModel({ id, label: id })
        && (models === null || models.some((model) => model.id === id)))
        .map((id) => buildBackgroundModelRequest(id, models));
    },
  };
}

export const sessionTitleModelsService = createSessionTitleModelsService({
  readSettings: (userId) => userSettingsDb.getSettings(userId),
  writeSettings: (userId, patch) => userSettingsDb.updateSettings(userId, patch, true),
  // Индекс sessions общий и не имеет user_id: фоновая индексация использует
  // того же первого активного пользователя, что single-user авторизация.
  getBackgroundUserId: () => userDb.getFirstUser()?.id,
  getCatalog: () => claudeApiModelCatalog.get(),
  resolveLegacyModel: () => resolveSmallModel('CLOUDCLI_SESSION_TITLE_MODEL'),
});
