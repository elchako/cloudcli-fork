import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import SettingsSection from '@/modules/settings/SettingsSection';
import SettingsToggle from '@/modules/settings/SettingsToggle';
import { useVoiceConfig } from '@/modules/settings/hooks/useVoiceConfig';
import {
  loadSpeechSummaryModels,
  loadSpeechSummaryStatus,
  type SpeechSummaryStatus,
} from '@/shared/speechSummary';
import { Button } from '@/shared/ui';

/** Same limit as the server (`SPEECH_SUMMARY_PROMPT_MAX_CHARS`); the server is
 * the one that enforces it, this only stops typing past it. */
const PROMPT_MAX_CHARS = 8000;

/**
 * GOLDJAXE fork (реестр §4.16, §4.16-бис): the read-aloud summary block of the
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
  // null while the list is loading: «loading» and «unavailable» read differently.
  const [models, setModels] = useState<string[] | null>(null);
  // The pick being saved, shown at once — the saved config changes only after
  // the server accepts it, and a slow phone link would otherwise snap it back.
  const [pendingModel, setPendingModel] = useState<string | null>(null);
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
    void loadSpeechSummaryModels().then((next) => {
      if (!cancelled) setModels(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const defaultPrompt = status?.defaultPrompt ?? '';
  const enabled = config.speechSummary !== 'off';
  const ownPrompt = config.speechSummaryPrompt.trim();
  const shownPrompt = draft ?? (ownPrompt || defaultPrompt);
  // The status is cached for the page's life, so the model in use is worked
  // out here from the saved choice, not taken from `status.model`.
  const defaultModel = status?.defaultModel || status?.model || '';
  const ownModel = config.speechSummaryModel.trim();
  const modelInUse = ownModel || defaultModel;
  // A saved model the endpoint no longer lists still shows as selected.
  const listedModels = models ?? [];
  const modelOptions = ownModel && !listedModels.includes(ownModel) ? [ownModel, ...listedModels] : listedModels;

  const run = async (patch: Parameters<typeof save>[0], okText: string, at: 'model' | 'block' = 'block') => {
    setSaving(true);
    setMessage(null);
    const result = await save(patch);
    setSaving(false);
    setMessage(result.ok ? { kind: 'ok', text: okText, at } : { kind: 'error', text: result.error ?? '', at });
    return result.ok;
  };

  const saveModel = async (value: string) => {
    setPendingModel(value);
    await run({ speechSummaryModel: value }, t('speechSummary.saved'), 'model');
    setPendingModel(null);
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

        {enabled && status?.available && (
          <div className="space-y-1">
            <label className="block space-y-1">
              <span className="text-sm font-medium text-foreground">{t('speechSummary.model')}</span>
              <select
                value={pendingModel ?? ownModel}
                onChange={(event) => void saveModel(event.target.value)}
                disabled={saving}
                className="w-full touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary"
              >
                <option value="">
                  {defaultModel
                    ? t('speechSummary.modelDefault', { model: defaultModel })
                    : t('speechSummary.modelDefaultNoName')}
                </option>
                {modelOptions.map((id) => (
                  <option key={id} value={id}>{id}</option>
                ))}
              </select>
            </label>
            <p className="text-xs text-muted-foreground">
              {models === null
                ? t('speechSummary.modelListLoading')
                : models.length ? t('speechSummary.modelHint') : t('speechSummary.modelListUnavailable')}
            </p>
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
