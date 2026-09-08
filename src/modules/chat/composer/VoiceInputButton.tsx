import { useTranslation } from 'react-i18next';
import { Mic, Square, Loader2 } from 'lucide-react';

import { PromptInputButton } from '@/modules/chat/composer/PromptInput';
import { cn } from '@/shared/utils';
import type { VoiceInputState } from '@/shared/types';

type Props = {
  state: VoiceInputState;
  onToggle: () => void;
  errorMsg?: string | null;
  /**
   * Fork: `floating` pins the mic inside the textarea's top-right corner, the
   * way Claude Code does it, instead of putting it in the footer row of small
   * controls. Dictation is the primary way this composer is used on a phone, so
   * it gets a large thumb-sized target rather than a 32px icon in a crowd.
   */
  variant?: 'toolbar' | 'floating';
  className?: string;
};

// Rendered by chat's ChatComposer next to the send button.
// Push-to-talk mic button (presentational). Recording state and the stop-and-send action
// are owned by the composer so the main Send button can drive them too. This button just
// starts recording and, while recording, stops and drops the transcript into the input box.
export default function VoiceInputButton({
  state,
  onToggle,
  errorMsg,
  variant = 'toolbar',
  className,
}: Props) {
  const { t } = useTranslation('chat');
  const label = state === 'recording' ? t('voice.stopRecording') : t('voice.input');

  const icon =
    state === 'recording' ? (
      <Square className="text-red-500" />
    ) : state === 'transcribing' ? (
      <Loader2 className="animate-spin" />
    ) : (
      <Mic />
    );

  if (variant === 'floating') {
    return (
      <span className={cn('relative inline-flex', className)}>
        {errorMsg && (
          <span className="absolute right-0 top-full mt-1 whitespace-nowrap rounded bg-red-600 px-2 py-1 text-xs text-white shadow-lg">
            {errorMsg}
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

  return (
    <span className={cn('relative inline-flex', className)}>
      {errorMsg && (
        <span className="absolute bottom-full left-1/2 mb-1 -translate-x-1/2 whitespace-nowrap rounded bg-red-600 px-2 py-1 text-xs text-white shadow-lg">
          {errorMsg}
        </span>
      )}
      <PromptInputButton
        tooltip={{ content: label }}
        onClick={(e: { preventDefault: () => void }) => {
          e.preventDefault();
          onToggle();
        }}
      >
        {icon}
      </PromptInputButton>
    </span>
  );
}
