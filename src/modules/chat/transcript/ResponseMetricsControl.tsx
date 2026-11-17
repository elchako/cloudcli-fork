import { useTranslation } from 'react-i18next';

import { useUiPreferences } from '@/shared/context/UiPreferencesContext';
import type { ResponseMetrics } from '@/shared/types';
import { formatGenerationSpeed, formatResponseDuration } from '@/modules/chat/utils/responseMetrics';

/** GOLDJAXE fork (реестр §26): тихий итог хода; native details работает тапом и с клавиатуры. */
export default function ResponseMetricsControl({ metrics }: { metrics: ResponseMetrics }) {
  const { t, i18n } = useTranslation('chat');
  const { showResponseDuration, showGenerationSpeed } = useUiPreferences();
  const language = i18n.resolvedLanguage || i18n.language || 'en';
  const duration = formatResponseDuration(metrics.durationMs, language);
  const exactDuration = formatResponseDuration(metrics.durationMs, language, true);
  const speed = formatGenerationSpeed(metrics.tokensPerSecond, language);
  const speedLabel = speed ? t('responseMetrics.rate', { value: speed }) : '';
  const parts = [showResponseDuration && duration, showGenerationSpeed && speedLabel].filter(Boolean);
  if (!parts.length) return null;

  const outcome = metrics.outcome === 'completed' ? '' : t(`responseMetrics.${metrics.outcome}`);
  const summary = [outcome, ...parts].filter(Boolean).join(' · ');
  const validOutput = typeof metrics.outputTokens === 'number' && Number.isFinite(metrics.outputTokens) && metrics.outputTokens >= 0;
  const apiDuration = typeof metrics.apiDurationMs === 'number'
    ? formatResponseDuration(metrics.apiDurationMs, language, true)
    : '';

  return (
    <details className="group min-w-0 max-w-full text-xs text-foreground/75 open:basis-full" data-response-metrics>
      <summary
        className="inline-flex min-h-11 cursor-pointer list-none items-center rounded-sm px-1 tabular-nums hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
        aria-label={t('responseMetrics.detailsLabel', { summary })}
      >
        {summary}
      </summary>
      <div className="mb-2 max-w-md space-y-2 rounded-md bg-muted/50 p-3 text-xs leading-relaxed">
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
          <dt>{t('responseMetrics.total')}</dt><dd className="text-right tabular-nums">{exactDuration}</dd>
          <dt>{t('responseMetrics.outcome')}</dt><dd className="text-right">{t(`responseMetrics.${metrics.outcome}`)}</dd>
          {apiDuration && <><dt>{t('responseMetrics.apiTime')}</dt><dd className="text-right tabular-nums">{apiDuration}</dd></>}
          {showGenerationSpeed && <><dt>{t('responseMetrics.average')}</dt><dd className="text-right tabular-nums">{speedLabel || t('responseMetrics.unavailable')}</dd></>}
          {validOutput && <><dt>{t('responseMetrics.output')}</dt><dd className="text-right tabular-nums">{new Intl.NumberFormat(language).format(metrics.outputTokens!)}</dd></>}
          {typeof metrics.sampledOutputTokens === 'number' && Number.isFinite(metrics.sampledOutputTokens) && <><dt>{t('responseMetrics.sampledOutput')}</dt><dd className="text-right tabular-nums">{new Intl.NumberFormat(language).format(metrics.sampledOutputTokens)}</dd></>}
          {metrics.model && <><dt>{t('responseMetrics.model')}</dt><dd className="max-w-48 break-words text-right">{metrics.model}</dd></>}
          {metrics.effort && <><dt>Effort</dt><dd className="text-right">{metrics.effort}</dd></>}
        </dl>
        <p>{t('responseMetrics.durationMethod')}</p>
        {showGenerationSpeed && <p>{t('responseMetrics.speedMethod')}</p>}
      </div>
    </details>
  );
}
