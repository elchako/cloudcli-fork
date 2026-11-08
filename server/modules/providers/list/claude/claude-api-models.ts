import { createHash } from 'node:crypto';

import {
  listApiModels,
  resolveSmallModelCredentials,
  type ApiModel,
  type SmallModelCredentials,
} from '@/shared/small-model.js';

type CatalogSource = 'api' | 'api-cache' | 'fallback';
type ApiCatalog = { models: ApiModel[] | null; source?: CatalogSource };
type Dependencies = {
  resolveCredentials?: () => Promise<SmallModelCredentials | null>;
  loadModels?: typeof listApiModels;
  now?: () => number;
};
type CacheEntry = {
  key: string;
  models: ApiModel[] | null;
  expiresAt: number;
  degraded: boolean;
  pending: Promise<void> | null;
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const RETRY_DELAY_MS = 30 * 1000;
const REQUEST_TIMEOUT_MS = 3000;

/**
 * GOLDJAXE fork (реестр §22): кэш привязан к endpoint и отпечатку credentials,
 * не к пользователю браузера. CLI использует те же общие настройки сервера.
 * При обновлении просроченного кэша уже известные модели возвращаются сразу.
 */
export function createClaudeApiModelCatalog(dependencies: Dependencies = {}) {
  const resolveCredentials = dependencies.resolveCredentials ?? resolveSmallModelCredentials;
  const loadModels = dependencies.loadModels ?? listApiModels;
  const now = dependencies.now ?? Date.now;
  let current: CacheEntry | null = null;

  async function get(force = false): Promise<ApiCatalog> {
    const credentials = await resolveCredentials();
    if (!credentials) {
      current = null;
      return { models: null };
    }
    const key = createHash('sha256')
      .update(JSON.stringify([credentials.baseUrl, credentials.isApiKey, credentials.token]))
      .digest('hex');
    if (current?.key !== key) {
      current = { key, models: null, expiresAt: 0, degraded: false, pending: null };
    }
    const entry = current;
    const view = (): ApiCatalog => ({
      models: entry.models ? structuredClone(entry.models) : null,
      source: entry.models ? (entry.degraded ? 'api-cache' : 'api') : 'fallback',
    });
    if (!force && now() < entry.expiresAt) return view();
    if (!entry.pending) {
      entry.degraded = Boolean(entry.models);
      entry.pending = (async () => {
        try {
          const models = await loadModels(credentials, { timeoutMs: REQUEST_TIMEOUT_MS, preferStandardIds: true });
          if (models?.length) {
            entry.models = models;
            entry.degraded = false;
            entry.expiresAt = now() + CACHE_TTL_MS;
          } else {
            entry.degraded = true;
            entry.expiresAt = now() + RETRY_DELAY_MS;
          }
        } catch {
          // Включая тестовый/подменённый транспорт: фон не даёт unhandled rejection.
          entry.degraded = true;
          entry.expiresAt = now() + RETRY_DELAY_MS;
        }
      })().finally(() => { entry.pending = null; });
    }
    if (force || !entry.models) await entry.pending;
    return view();
  }

  return { get, refresh: () => get(true) };
}

export const claudeApiModelCatalog = createClaudeApiModelCatalog();

/** Маска CLIProxyAPI нужна только для метаданных/effort, SDK получает исходный ID. */
export function decodeCliProxyModelId(model: string): string {
  const prefix = 'claude-fable-5-dd-';
  return model.startsWith(prefix) ? [...model.slice(prefix.length)].reverse().join('') : model;
}
