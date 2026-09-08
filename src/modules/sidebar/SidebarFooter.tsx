import { Settings, ArrowUpCircle, AlertTriangle } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Tooltip } from '@/shared/ui';
import { IS_PLATFORM } from '@/shared/utils';
import type { ReleaseInfo } from '@/shared/types';

const GITHUB_REPO_URL = 'https://github.com/siteboon/claudecodeui';

type SidebarFooterProps = {
  updateAvailable: boolean;
  restartRequired: boolean;
  releaseInfo: ReleaseInfo | null;
  latestVersion: string | null;
  currentVersion: string;
  onShowVersionModal: () => void;
  onShowSettings: () => void;
  t: TFunction;
};

/**
 * One-line sidebar footer.
 *
 * Upstream stacks up to four full-width bands here (restart banner, update
 * banner, settings row, brand line), each with its own padding and divider.
 * On a phone that ate a visible slice of the session list for information that
 * is mostly idle: the update notice is a "some day" prompt, not a task.
 *
 * So status collapses into icon-sized affordances sharing the settings row:
 * the text lives in a tooltip (desktop) and in the modal the icon opens, which
 * is where the user acts on it anyway. Nothing is removed — only the resting
 * footprint shrinks from several stacked bands to a single row.
 */
export default function SidebarFooter({
  updateAvailable,
  restartRequired,
  releaseInfo,
  latestVersion,
  currentVersion,
  onShowVersionModal,
  onShowSettings,
  t,
}: SidebarFooterProps) {
  const updateLabel = releaseInfo?.title || (latestVersion ? `v${latestVersion}` : '');
  const updateTooltip = updateLabel
    ? `${t('version.updateAvailable')} — ${updateLabel}`
    : t('version.updateAvailable');

  return (
    <div className="flex-shrink-0" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0)' }}>
      <div className="nav-divider" />

      {/* Single row: settings on the left, status icons on the right. Taller
          touch targets on mobile (44px) than on desktop, where a pointer is
          precise and vertical space is cheaper. */}
      <div className="flex items-center gap-1 px-2 py-1.5 md:px-2 md:py-1">
        <button
          className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground md:h-8 md:gap-2 md:px-2.5"
          onClick={onShowSettings}
        >
          <Settings className="h-4 w-4 flex-shrink-0 md:h-3.5 md:w-3.5" />
          <span className="truncate text-sm">{t('actions.settings')}</span>
        </button>

        {/* Restart required: the running server differs from the installed
            version. Amber, and placed before the update icon because it is the
            more urgent of the two. */}
        {restartRequired && (
          <Tooltip content={t('version.restartRequired')} position="top">
            <button
              type="button"
              onClick={onShowVersionModal}
              aria-label={t('version.restartRequired')}
              className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg text-amber-500 transition-colors hover:bg-amber-50/80 dark:text-amber-400 dark:hover:bg-amber-900/15 md:h-8 md:w-8"
            >
              <AlertTriangle className="h-4 w-4" />
            </button>
          </Tooltip>
        )}

        {updateAvailable && (
          <Tooltip content={updateTooltip} position="top">
            <button
              type="button"
              onClick={onShowVersionModal}
              aria-label={updateTooltip}
              className="relative flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg text-blue-500 transition-colors hover:bg-blue-50/80 dark:text-blue-400 dark:hover:bg-blue-900/15 md:h-8 md:w-8"
            >
              <ArrowUpCircle className="h-4 w-4" />
              {/* Pulsing dot: the only thing that has to catch the eye from
                  across the sidebar now that the label is gone. */}
              <span className="absolute right-2 top-2 h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500 md:right-1.5 md:top-1.5" />
            </button>
          </Tooltip>
        )}

        {/* Version + project link, desktop only: reference material, not an
            action, so it stays out of the way on a phone. */}
        {!IS_PLATFORM && (
          <a
            href={GITHUB_REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="hidden flex-shrink-0 px-1.5 text-[10px] text-muted-foreground/40 transition-colors hover:text-muted-foreground md:block"
          >
            v{currentVersion}
          </a>
        )}
      </div>
    </div>
  );
}
