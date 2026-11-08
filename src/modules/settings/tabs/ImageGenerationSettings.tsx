import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsSection from '@/modules/settings/SettingsSection';
import { authenticatedFetch } from '@/shared/api';
import {
  IMAGE_PROFILE_IDS, IMAGE_QUALITY_IDS,
  type ImageGenerationSettings as Profiles, type ImageProfile,
} from '@/shared/imageGeneration';
import { groupModelsByCatalogProvider } from '@/shared/modelProviderGroups';
import { Button } from '@/shared/ui';

type Snapshot = {
  settings: Profiles;
  models: { id: string; label: string; catalogProvider?: string }[] | null;
};
type ResponseBody = Snapshot & { success: boolean; error?: { code?: string } };
const ENDPOINT = '/api/settings/image-generation';

// GOLDJAXE fork (реестр §13.3): серверная настройка, не localStorage или каталог в UI.
export default function ImageGenerationSettings() {
  const { t } = useTranslation('settings');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState<Profiles | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<'loadError' | 'saveError' | 'saved' | 'modelUnavailable' | 'catalogUnavailable' | null>(null);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(async (refresh = false) => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    try {
      const response = await authenticatedFetch(`${ENDPOINT}${refresh ? '?refresh=1' : ''}`, { signal: request.signal });
      const next = await response.json() as ResponseBody;
      if (!response.ok || !next.success) throw new Error('settings');
      if (!request.signal.aborted) {
        setSnapshot(next);
        // Обновление каталога не затирает несохранённый выбор.
        if (!refresh) setDraft(next.settings);
      }
    } catch {
      if (!request.signal.aborted) setMessage('loadError');
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    // Загрузка внешних данных начинается асинхронно; cleanup защищает StrictMode/unmount.
    queueMicrotask(() => { if (active) void load(); });
    return () => { active = false; controller.current?.abort(); };
  }, [load]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setMessage(null);
    try {
      const response = await authenticatedFetch(ENDPOINT, { method: 'PUT', body: JSON.stringify(draft) });
      const next = await response.json() as ResponseBody;
      if (!response.ok || !next.success) {
        setMessage(next.error?.code === 'IMAGE_MODEL_UNAVAILABLE' ? 'modelUnavailable'
          : next.error?.code === 'IMAGE_CATALOG_UNAVAILABLE' ? 'catalogUnavailable' : 'saveError');
        return;
      }
      setSnapshot((current) => current ? { ...current, settings: next.settings } : current);
      setDraft(next.settings);
      setMessage('saved');
    } catch {
      setMessage('saveError');
    } finally {
      setSaving(false);
    }
  };

  const models = snapshot?.models ?? [];
  const groups = groupModelsByCatalogProvider(models.map((model) => ({
    value: model.id, label: model.label, catalogProvider: model.catalogProvider,
  })), { default: t('chat:composer.defaultModelGroup'), unassigned: t('chat:composer.unassignedModelGroup') });
  const missing = snapshot?.models !== null && draft
    && IMAGE_PROFILE_IDS.some((id) => !models.some((model) => model.id === draft.profiles[id].model));
  const changed = Boolean(draft && snapshot && JSON.stringify(draft) !== JSON.stringify(snapshot.settings));
  const update = (id: ImageProfile, field: 'model' | 'quality', value: string) => {
    setDraft((current) => current ? { ...current, profiles: {
      ...current.profiles, [id]: { ...current.profiles[id], [field]: value },
    } } : current);
    setMessage(null);
  };
  const selectClass = 'min-h-11 w-full min-w-0 touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary disabled:opacity-60';

  return (
    <SettingsSection title={t('imageGeneration.title')} description={t('imageGeneration.description')}>
      <SettingsCard className="min-w-0 space-y-5 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">{t('imageGeneration.catalogHint')}</p>
          <Button variant="outline" size="sm" className="min-h-11" disabled={loading || saving || !snapshot} onClick={() => { setLoading(true); setMessage(null); void load(true); }}>
            {t('imageGeneration.refresh')}
          </Button>
        </div>
        {loading && <p role="status" className="text-sm text-muted-foreground">{t('imageGeneration.loading')}</p>}
        {draft && snapshot && (
          <>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">{t('imageGeneration.defaultProfile')}</span>
              <select className={selectClass} value={draft.defaultProfile} disabled={loading || saving} onChange={(event) => {
                setDraft({ ...draft, defaultProfile: event.target.value as ImageProfile });
                setMessage(null);
              }}>
                {IMAGE_PROFILE_IDS.map((id) => <option key={id} value={id}>{t(`imageGeneration.profiles.${id}`)}</option>)}
              </select>
            </label>
            <div className="space-y-5">
              {IMAGE_PROFILE_IDS.map((id) => {
                const profile = draft.profiles[id];
                const absent = !models.some((model) => model.id === profile.model);
                return (
                  <fieldset key={id} className="min-w-0 space-y-2 border-t border-border pt-4">
                    <legend className="px-1 text-sm font-medium">{t(`imageGeneration.profiles.${id}`)}</legend>
                    <p className="text-xs text-muted-foreground">{t(`imageGeneration.purposes.${id}`)}</p>
                    <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                      <label className="block min-w-0 space-y-1.5">
                        <span className="text-sm">{t('imageGeneration.model')}</span>
                        <select className={selectClass} value={profile.model} disabled={loading || saving} onChange={(event) => update(id, 'model', event.target.value)}>
                          {absent && <option value={profile.model} disabled>{t('imageGeneration.unavailableModel', { model: profile.model })}</option>}
                          {groups.map((group) => {
                            const options = group.models.map((model) => <option key={model.value} value={model.value}>{model.label === model.value ? model.value : `${model.label} (${model.value})`}</option>);
                            return group.name ? <optgroup key={group.key} label={group.name}>{options}</optgroup> : <Fragment key={group.key}>{options}</Fragment>;
                          })}
                        </select>
                      </label>
                      <label className="block min-w-0 space-y-1.5">
                        <span className="text-sm">{t('imageGeneration.quality')}</span>
                        <select className={selectClass} value={profile.quality} disabled={loading || saving} onChange={(event) => update(id, 'quality', event.target.value)}>
                          {IMAGE_QUALITY_IDS.map((quality) => <option key={quality} value={quality}>{t(`imageGeneration.qualities.${quality}`)}</option>)}
                        </select>
                      </label>
                    </div>
                  </fieldset>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">{t('imageGeneration.qualityHint')}</p>
            {snapshot.models === null && <p className="text-sm text-muted-foreground">{t('imageGeneration.catalogUnavailable')}</p>}
            {snapshot.models?.length === 0 && <p className="text-sm text-muted-foreground">{t('imageGeneration.noModels')}</p>}
            {missing && <p role="status" className="text-sm text-amber-700 dark:text-amber-400">{t('imageGeneration.missingModel')}</p>}
            <Button size="sm" className="min-h-11" disabled={!changed || loading || saving} onClick={() => void save()}>
              {t(saving ? 'imageGeneration.saving' : 'imageGeneration.save')}
            </Button>
          </>
        )}
        {message && <p role={message === 'saved' ? 'status' : 'alert'} className={message === 'saved' ? 'text-sm text-muted-foreground' : 'text-sm text-red-600 dark:text-red-400'}>{t(`imageGeneration.${message}`)}</p>}
        {message === 'loadError' && <Button variant="outline" className="min-h-11" onClick={() => { setLoading(true); setMessage(null); void load(Boolean(snapshot)); }}>{t('imageGeneration.retry')}</Button>}
      </SettingsCard>
    </SettingsSection>
  );
}
