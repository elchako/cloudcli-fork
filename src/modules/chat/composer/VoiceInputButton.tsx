import { useTranslation } from 'react-i18next';
import { Mic, Square, Loader2 } from 'lucide-react';

import { cn } from '@/shared/utils';
import type { VoiceInputState } from '@/shared/types';

type Props = {
  state: VoiceInputState;
  onToggle: () => void;
  errorMsg?: string | null;
  /** Fork (§4.14): neutral status — retrying, dictation queued, queued one delivered. */
  noticeMsg?: string | null;
  className?: string;
};

/**
 * Push-to-talk mic button (presentational). Recording state and the
 * stop-and-send action are owned by the composer so the main Send button can
 * drive them too. This button just starts recording and, while recording, stops
 * and drops the transcript into the input box.
 *
 * Fork: positioned by the caller inside the textarea's top-right corner, the way
 * Claude Code places it, rather than sitting in the composer footer. Upstream
 * renders it as one 32px icon among five, which is hard to hit with a thumb and
 * easy to miss with a pointer; dictation is how this composer is used nearly all
 * the time, so it gets its own target — the same one on every width.
 */
export default function VoiceInputButton({ state, onToggle, errorMsg, noticeMsg, className }: Props) {
  const { t } = useTranslation('chat');
  const label = state === 'recording' ? t('voice.stopRecording') : t('voice.input');
  const bubble = errorMsg || noticeMsg;

  const icon =
    state === 'recording' ? (
      <Square className="text-red-500" />
    ) : state === 'transcribing' ? (
      <Loader2 className="animate-spin" />
    ) : (
      <Mic />
    );

  return (
    <span className={cn('relative inline-flex', className)}>
      {bubble && (
        // Opens downwards: above the button is the top edge of the composer,
        // which would clip the message. Fork: wraps within a phone-width cap —
        // the queue messages are a sentence long and ran off a 360px screen.
        <span
          role="status"
          className={cn(
            'absolute right-0 top-full z-10 mt-1 w-max max-w-[min(18rem,calc(100vw-2rem))] whitespace-normal rounded px-2 py-1 text-xs text-white shadow-lg',
            errorMsg ? 'bg-red-600' : 'bg-neutral-800 dark:bg-neutral-700',
          )}
        >
          {bubble}
        </span>
      )}
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          onToggle();
        }}
        aria-label={label}
        title={label}
        className={cn(
          'flex h-9 w-9 items-center justify-center rounded-full border transition-colors [&_svg]:h-[18px] [&_svg]:w-[18px]',
          state === 'recording'
            ? 'border-red-500/40 bg-red-500/10 text-red-500'
            : 'border-border/60 bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
      >
        {icon}
      </button>
    </span>
  );
}
