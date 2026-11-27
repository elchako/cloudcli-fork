import { useState } from 'react';
import { Loader2, Pin } from 'lucide-react';
import type { TFunction } from 'i18next';

import { cn } from '@/shared/utils';

// GOLDJAXE fork (реестр §28): поиск использует тот же пин, что обе вкладки.
export default function SessionPinButton({ sessionId, sessionName, isPinned, onToggle, t }: {
  sessionId: string;
  sessionName: string;
  isPinned: boolean;
  onToggle?: (sessionId: string) => Promise<void>;
  t: TFunction;
}) {
  const [isPending, setIsPending] = useState(false);
  if (!onToggle) return null;
  const label = isPinned ? t('pinned.unpin', 'Unpin session') : t('pinned.pin', 'Pin session');
  return (
    <button
      type="button"
      className={cn(
        'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40',
        isPinned ? 'text-primary' : 'text-muted-foreground/50 hover:text-foreground',
      )}
      title={label}
      aria-label={`${label}: ${sessionName}`}
      aria-pressed={isPinned}
      disabled={isPending}
      onClick={() => {
        setIsPending(true);
        void onToggle(sessionId).finally(() => setIsPending(false));
      }}
    >
      {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : (
        <Pin className={cn('h-3.5 w-3.5', isPinned && 'fill-primary/15')} />
      )}
    </button>
  );
}
