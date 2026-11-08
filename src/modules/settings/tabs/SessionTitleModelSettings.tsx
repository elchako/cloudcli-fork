import { Fragment, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsSection from '@/modules/settings/SettingsSection';
import { groupModelsByCatalogProvider } from '@/shared/modelProviderGroups';
import type { ProviderModelOption } from '@/shared/types';
import { authenticatedFetch } from '@/shared/api';
import { Button } from '@/shared/ui';

type ModelSettings = { primaryModel: string; fallbackModel: string };
type Snapshot = {
  settings: ModelSettings;
  models: { id: string; label: string; catalogProvider?: string }[] | null;
  legacyModel: string | null;
};
type SettingsResponse = Snapshot & { success: boolean; error?: { code?: string } };

const ENDPOINT = '/api/settings/session-title-models';

// GOLDJAXE fork (реестр §4.9-тер): отдельная пара ID из серверного API-каталога.
// Не используем модель чата/сводки, localStorage и вторую синхронизацию настроек.
export default function SessionTitleModelSettings() {
  const { t } = useTranslation('settings');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState<ModelSettings>({ primaryModel: '', fallbackModel: '' });
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<'saved' | 'loadError' | 'saveError' | 'modelUnavailable' | 'catalogUnavailable' | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await authenticatedFetch(ENDPOINT, { signal: controller.signal });
        const next = await response.json() as SettingsResponse;
        if (!response.ok || !next.success) throw new Error('settings');
        if (!controller.signal.aborted) {
          setSnapshot(next);
          setDraft(next.settings);
        }
      } catch {
        if (!controller.signal.aborted) setMessage('loadError');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [loadAttempt]);

  const models = snapshot?.models ?? [];
  const modelGroups = groupModelsByCatalogProvider(models.map((model) => ({
    value: model.id, label: model.label, catalogProvider: model.catalogProvider,
  })), { default: t('chat:composer.defaultModelGroup'), unassigned: t('chat:composer.unassignedModelGroup') });
  const changed = draft.primaryModel !== snapshot?.settings.primaryModel
    || draft.fallbackModel !== snapshot?.settings.fallbackModel;
  const complete = Boolean(draft.primaryModel && draft.fallbackModel && draft.primaryModel !== draft.fallbackModel);
  const missingSavedModel = snapshot?.models !== null && Boolean(snapshot)
    && [snapshot?.settings.primaryModel, snapshot?.settings.fallbackModel]
      .some((id) => id && !models.some((model) => model.id === id));

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const response = await authenticatedFetch(ENDPOINT, { method: 'PUT', body: JSON.stringify(draft) });
      const result = await response.json() as SettingsResponse;
      if (!response.ok || !result.success) {
        setMessage(result.error?.code === 'SESSION_TITLE_MODEL_UNAVAILABLE' ? 'modelUnavailable'
          : result.error?.code === 'SESSION_TITLE_CATALOG_UNAVAILABLE' ? 'catalogUnavailable' : 'saveError');
        return;
      }
      setSnapshot((current) => current ? { ...current, settings: result.settings, legacyModel: null } : current);
      setDraft(result.settings);
      setMessage('saved');
    } catch {
      setMessage('saveError');
    } finally {
      setSaving(false);
    }
  };

  const select = (field: keyof ModelSettings, other: keyof ModelSettings) => {
    const unavailable = draft[field] && !models.some((model) => model.id === draft[field]);
    const option = (model: ProviderModelOption) => (
      <option key={model.value} value={model.value} disabled={model.value === draft[other]}>
        {model.label === model.value ? model.value : `${model.label} (${model.value})`}
      </option>
    );
    return (
      <label className="block min-w-0 space-y-1.5">
        <span className="text-sm font-medium text-foreground">{t(`sessionTitles.${field}`)}</span>
        <select
          value={draft[field]}
          onChange={(event) => {
            setDraft((current) => ({ ...current, [field]: event.target.value }));
            setMessage(null);
          }}
          disabled={loading || saving}
          className="min-h-11 w-full min-w-0 touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary disabled:opacity-60"
        >
          <option value="">{t('sessionTitles.choose')}</option>
          {unavailable && <option value={draft[field]} disabled>{t('sessionTitles.unavailableModel', { model: draft[field] })}</option>}
          {modelGroups.map((group) => group.name
            ? <optgroup key={group.key} label={group.name}>{group.models.map(option)}</optgroup>
            : <Fragment key={group.key}>{group.models.map(option)}</Fragment>)}
        </select>
      </label>
    );
  };

  return (
    <SettingsSection title={t('sessionTitles.title')} description={t('sessionTitles.description')}>
      <SettingsCard className="space-y-4 p-4">
        {loading && <p role="status" className="text-sm text-muted-foreground">{t('sessionTitles.loading')}</p>}
        {snapshot && (
          <>
            <div className="grid min-w-0 gap-4 sm:grid-cols-2">
              {select('primaryModel', 'fallbackModel')}
              {select('fallbackModel', 'primaryModel')}
            </div>
            <p className="text-xs text-muted-foreground">{t('sessionTitles.effortHint')}</p>
            {snapshot.models === null && (
              <p className="text-sm text-muted-foreground">{t('sessionTitles.catalogUnavailable')}</p>
            )}
            {snapshot.models?.length === 0 && (
              <p className="text-sm text-muted-foreground">{t('sessionTitles.noModels')}</p>
            )}
            {(!snapshot.settings.primaryModel || !snapshot.settings.fallbackModel) && (
              <p className="text-sm text-muted-foreground">{t('sessionTitles.setupRequired')}</p>
            )}
            {snapshot.legacyModel && (
              <p className="break-words text-sm text-muted-foreground">{t('sessionTitles.legacy', { model: snapshot.legacyModel })}</p>
            )}
            {missingSavedModel && <p className="text-sm text-muted-foreground">{t('sessionTitles.missingSavedModel')}</p>}
            <Button size="sm" className="min-h-11" onClick={() => void save()} disabled={!changed || !complete || saving || loading}>
              {t(saving ? 'sessionTitles.saving' : 'sessionTitles.save')}
            </Button>
          </>
        )}
        {message && (
          <p role={message === 'saved' ? 'status' : 'alert'} className={message === 'saved' ? 'text-sm text-muted-foreground' : 'text-sm text-red-600 dark:text-red-400'}>
            {t(`sessionTitles.${message}`)}
          </p>
        )}
        {message === 'loadError' && (
          <Button size="sm" variant="outline" className="min-h-11" onClick={() => {
            setLoading(true);
            setMessage(null);
            setLoadAttempt((value) => value + 1);
          }}>
            {t('sessionTitles.retry')}
          </Button>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}
