import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import SettingsSection from '@/modules/settings/SettingsSection';
import SettingsToggle from '@/modules/settings/SettingsToggle';
import { useVoiceConfig } from '@/modules/settings/hooks/useVoiceConfig';
import { loadSpeechSummaryStatus, type SpeechSummaryStatus } from '@/shared/speechSummary';
import { Button } from '@/shared/ui';

/** Same limit as the server (`SPEECH_SUMMARY_PROMPT_MAX_CHARS`); the server is
 * the one that enforces it, this only stops typing past it. */
const PROMPT_MAX_CHARS = 8000;

/**
 * GOLDJAXE fork (реестр §4.16): the read-aloud summary block of the Voice tab.
 *
 * The switch saves at once. The instruction is edited as a draft and saved by
 * a button: it is long, saving every keystroke would be noise, and a rejected
 * save (over the limit) has to be shown rather than swallowed.
 */
export default function SpeechSummarySettings() {
  const { t } = useTranslation('settings');
  const { config, save } = useVoiceConfig();
  const [status, setStatus] = useState<SpeechSummaryStatus | null | undefined>(undefined);
  const [draft, setDraft] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
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

  const defaultPrompt = status?.defaultPrompt ?? '';
  const enabled = config.speechSummary !== 'off';
  const ownPrompt = config.speechSummaryPrompt.trim();
  const shownPrompt = draft ?? (ownPrompt || defaultPrompt);

  const run = async (patch: Parameters<typeof save>[0], okText: string) => {
    setSaving(true);
    setMessage(null);
    const result = await save(patch);
    setSaving(false);
    setMessage(result.ok ? { kind: 'ok', text: okText } : { kind: 'error', text: result.error ?? '' });
    return result.ok;
  };

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
        {status === null && (
          <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
            {t('speechSummary.unavailable')}
          </p>
        )}

        <div className="flex items-center justify-between rounded-lg border border-border p-3">
          <div className="pr-3">
            <div className="text-sm font-medium text-foreground">{t('speechSummary.enable')}</div>
            <div className="text-xs text-muted-foreground">
              {status?.model
                ? t('speechSummary.enableDescription', { model: status.model })
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

        {message && (
          <p
            role={message.kind === 'error' ? 'alert' : 'status'}
            className={message.kind === 'error' ? 'text-sm text-red-600 dark:text-red-400' : 'text-sm text-muted-foreground'}
          >
            {message.text}
          </p>
        )}
      </div>
    </SettingsSection>
  );
}
