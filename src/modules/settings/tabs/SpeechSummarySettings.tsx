import { Fragment, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import SettingsSection from '@/modules/settings/SettingsSection';
import SettingsToggle from '@/modules/settings/SettingsToggle';
import { useVoiceConfig } from '@/modules/settings/hooks/useVoiceConfig';
import {
  loadSpeechSummaryModels,
  loadSpeechSummaryStatus,
  type SpeechSummaryStatus,
  type SpeechSummaryModels,
} from '@/shared/speechSummary';
import { groupModelsByCatalogProvider } from '@/shared/modelProviderGroups';
import type { ProviderModelOption } from '@/shared/types';
import { Button } from '@/shared/ui';

/** Same limit as the server (`SPEECH_SUMMARY_PROMPT_MAX_CHARS`); the server is
 * the one that enforces it, this only stops typing past it. */
const PROMPT_MAX_CHARS = 8000;

/**
 * GOLDJAXE fork (реестр §4.16, §4.16-бис, §4.16-тер): the read-aloud summary block of the
 * Voice tab.
 *
 * The switch and the model save at once. The instruction is edited as a draft
 * and saved by a button: it is long, saving every keystroke would be noise, and
 * a rejected save (over the limit) has to be shown rather than swallowed.
 */
export default function SpeechSummarySettings() {
  const { t } = useTranslation('settings');
  const { config, save } = useVoiceConfig();
  const [status, setStatus] = useState<SpeechSummaryStatus | null | undefined>(undefined);
  const [catalog, setCatalog] = useState<SpeechSummaryModels | null>(null);
  const [refreshAttempt, setRefreshAttempt] = useState(0);
  const [loadingModels, setLoadingModels] = useState(true);
  // Сразу показываем сохраняемый выбор, не дёргая select на медленной связи.
  const [pendingModel, setPendingModel] = useState<{ field: 'speechSummaryModel' | 'speechSummaryFallbackModel'; value: string } | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  // `at` puts the message next to what was saved: on a phone the bottom of the
  // block is off screen while the model list is in view.
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string; at: 'model' | 'block' } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadSpeechSummaryStatus().then((next) => {
      if (!cancelled) setStatus(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadSpeechSummaryModels(refreshAttempt > 0).then((next) => {
      if (cancelled) return;
      setCatalog((previous) => next.models === null && previous?.models
        ? { ...previous, source: 'api-cache' } : next);
      setLoadingModels(false);
    });
    return () => { cancelled = true; };
  }, [refreshAttempt]);

  const defaultPrompt = status?.defaultPrompt ?? '';
  const enabled = config.speechSummary !== 'off';
  const ownPrompt = config.speechSummaryPrompt.trim();
  const shownPrompt = draft ?? (ownPrompt || defaultPrompt);
  // The status is cached for the page's life, so the model in use is worked
  // out here from the saved choice, not taken from `status.model`.
  const defaultModel = status?.defaultModel || status?.model || '';
  const ownModel = config.speechSummaryModel.trim();
  const modelInUse = ownModel || defaultModel;
  const fallbackModel = config.speechSummaryFallbackModel.trim();
  const listedModels = catalog?.models ?? [];
  const modelGroups = groupModelsByCatalogProvider(listedModels.map((model) => ({
    value: model.id, label: model.label, catalogProvider: model.catalogProvider,
  })), { default: t('chat:composer.defaultModelGroup'), unassigned: t('chat:composer.unassignedModelGroup') });
  const missingModels = catalog?.models !== null && catalog !== null && catalog.source !== 'api-cache'
    && [modelInUse, fallbackModel].some((id) => id && !listedModels.some((model) => model.id === id));

  const run = async (patch: Parameters<typeof save>[0], okText: string, at: 'model' | 'block' = 'block') => {
    setSaving(true);
    setMessage(null);
    const result = await save(patch);
    setSaving(false);
    setMessage(result.ok ? { kind: 'ok', text: okText, at } : { kind: 'error', text: result.error ?? '', at });
    return result.ok;
  };

  const saveModel = async (field: 'speechSummaryModel' | 'speechSummaryFallbackModel', value: string) => {
    setPendingModel({ field, value });
    await run({ [field]: value }, t('speechSummary.saved'), 'model');
    setPendingModel(null);
  };

  const modelSelect = (field: 'speechSummaryModel' | 'speechSummaryFallbackModel') => {
    const primary = field === 'speechSummaryModel';
    const value = pendingModel?.field === field ? pendingModel.value : config[field].trim();
    const other = primary ? fallbackModel : modelInUse;
    const absent = value && !listedModels.some((model) => model.id === value);
    const option = (model: ProviderModelOption) => (
      <option key={model.value} value={model.value} disabled={model.value === other}>
        {model.label === model.value ? model.value : `${model.label} (${model.value})`}
      </option>
    );
    return (
      <label className="block min-w-0 space-y-1.5">
        <span className="text-sm font-medium text-foreground">{t(primary ? 'speechSummary.model' : 'speechSummary.fallbackModel')}</span>
        <select
          value={value}
          onChange={(event) => void saveModel(field, event.target.value)}
          disabled={saving}
          className="min-h-11 w-full min-w-0 touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary disabled:opacity-60"
        >
          <option value="" disabled={primary && Boolean(defaultModel && defaultModel === other)}>
            {primary ? (defaultModel ? t('speechSummary.modelDefault', { model: defaultModel })
              : t('speechSummary.modelDefaultNoName')) : t('speechSummary.fallbackNone')}
          </option>
          {absent && <option value={value} disabled>{value}</option>}
          {modelGroups.map((group) => group.name
            ? <optgroup key={group.key} label={group.name}>{group.models.map(option)}</optgroup>
            : <Fragment key={group.key}>{group.models.map(option)}</Fragment>)}
        </select>
      </label>
    );
  };

  const messageView = message && (
    <p
      role={message.kind === 'error' ? 'alert' : 'status'}
      className={message.kind === 'error' ? 'text-sm text-red-600 dark:text-red-400' : 'text-sm text-muted-foreground'}
    >
      {message.text}
    </p>
  );

  const savePrompt = async () => {
    const value = (draft ?? shownPrompt).trim();
    // The built-in text saved back unchanged is stored as '' so a later change
    // of the built-in instruction still reaches this user.
    const stored = value === defaultPrompt.trim() ? '' : value;
    if (await run({ speechSummaryPrompt: stored }, t('speechSummary.saved'))) {
      setDraft(null);
    }
  };

  const resetPrompt = async () => {
    if (await run({ speechSummaryPrompt: '' }, t('speechSummary.resetDone'))) {
      setDraft(null);
    }
  };

  return (
    <SettingsSection title={t('speechSummary.title')} description={t('speechSummary.description')}>
      <div className="space-y-4">
        {(status === null || status?.available === false) && (
          <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
            {t('speechSummary.unavailable')}
          </p>
        )}

        <div className="flex items-center justify-between rounded-lg border border-border p-3">
          <div className="pr-3">
            <div className="text-sm font-medium text-foreground">{t('speechSummary.enable')}</div>
            <div className="text-xs text-muted-foreground">
              {modelInUse
                ? t('speechSummary.enableDescription', { model: modelInUse })
                : t('speechSummary.enableDescriptionNoModel')}
            </div>
          </div>
          <SettingsToggle
            checked={enabled}
            onChange={(value) => void run({ speechSummary: value ? 'on' : 'off' }, t('speechSummary.saved'))}
            ariaLabel={t('speechSummary.enable')}
            disabled={saving}
          />
        </div>

        {enabled && (
          <div className="min-w-0 space-y-3">
            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              {modelSelect('speechSummaryModel')}
              {modelSelect('speechSummaryFallbackModel')}
            </div>
            <p className="text-xs text-muted-foreground">{t('speechSummary.modelHint')}</p>
            <p className="text-xs text-muted-foreground">{t('speechSummary.fallbackHint')}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" className="min-h-11" disabled={loadingModels} onClick={() => {
                setLoadingModels(true);
                setRefreshAttempt((value) => value + 1);
              }}>
                {t(loadingModels ? 'speechSummary.modelListLoading' : 'speechSummary.refreshModels')}
              </Button>
            </div>
            {!loadingModels && catalog?.models === null && (
              <p role="status" className="text-sm text-muted-foreground">{t('speechSummary.modelListUnavailable')}</p>
            )}
            {!loadingModels && catalog?.models?.length === 0 && (
              <p role="status" className="text-sm text-muted-foreground">{t('speechSummary.modelListEmpty')}</p>
            )}
            {catalog?.source === 'api-cache' && (
              <p role="status" className="text-sm text-muted-foreground">{t('speechSummary.catalogCached')}</p>
            )}
            {missingModels && (
              <p role="status" className="text-sm text-muted-foreground">{t('speechSummary.modelMissing')}</p>
            )}
            {message?.at === 'model' && messageView}
          </div>
        )}

        {enabled && (
          <div className="space-y-2">
            <label className="block space-y-1">
              <span className="text-sm font-medium text-foreground">{t('speechSummary.prompt')}</span>
              <textarea
                className="min-h-56 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                value={shownPrompt}
                maxLength={PROMPT_MAX_CHARS}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setMessage(null);
                }}
              />
            </label>
            <p className="text-xs text-muted-foreground">
              {ownPrompt ? t('speechSummary.usingOwn') : t('speechSummary.usingDefault')}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void savePrompt()} disabled={saving || draft === null}>
                {t('speechSummary.save')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void resetPrompt()}
                disabled={saving || (!ownPrompt && draft === null)}
              >
                {t('speechSummary.reset')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t('speechSummary.note')}</p>
          </div>
        )}

        {message?.at === 'block' && messageView}
      </div>
    </SettingsSection>
  );
}
