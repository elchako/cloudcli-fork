import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { CloudOff, Download, Loader2, RotateCw, Trash2 } from 'lucide-react';

import { cn } from '@/shared/utils';
import type { VoiceOutboxControls, VoiceOutboxItem } from '@/modules/chat/hooks/useVoiceOutbox';
import { formatVoiceDuration } from '@/shared/voiceOutbox';

/** Сколько держится «Удалить безвозвратно?», если не подтвердили. */
const CONFIRM_TIMEOUT_MS = 4000;

function statusText(item: VoiceOutboxItem, t: TFunction): string {
  if (item.sending) return t('voice.outbox.statusSending');
  if (item.permanent) return t('voice.outbox.statusRejected', { error: item.lastError ?? '' });
  if (item.status === 'recording') return t('voice.outbox.statusInterrupted');
  if (item.lastError === 'offline') return t('voice.outbox.statusOffline');
  if (item.attempts === 0 || !item.lastError) return t('voice.outbox.statusWaiting');
  return t('voice.outbox.statusRetry', { error: item.lastError });
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(event) => {
        event.preventDefault();
        onClick();
      }}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50 [&_svg]:h-4 [&_svg]:w-4"
    >
      {children}
    </button>
  );
}

function OutboxRow({ item, outbox }: { item: VoiceOutboxItem; outbox: VoiceOutboxControls }) {
  const { t } = useTranslation('chat');
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return undefined;
    const timer = setTimeout(() => setConfirming(false), CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [confirming]);

  const time = new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="flex items-center gap-2 text-xs">
      <CloudOff className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-foreground">
          {t('voice.outbox.title', { duration: formatVoiceDuration(item.durationMs), time })}
        </div>
        {/* Две строки, а не обрезка: причина отказа — то, ради чего строку читают. */}
        <div className={cn('line-clamp-2 break-words', item.permanent ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground')}>
          {statusText(item, t)}
        </div>
      </div>
      <IconButton label={t('voice.outbox.send')} onClick={() => outbox.sendNow(item.id)} disabled={item.sending}>
        {item.sending ? <Loader2 className="animate-spin" /> : <RotateCw />}
      </IconButton>
      <IconButton label={t('voice.outbox.download')} onClick={() => void outbox.download(item.id)}>
        <Download />
      </IconButton>
      {confirming ? (
        <button
          type="button"
          onClick={(event) => {
            event.preventDefault();
            setConfirming(false);
            void outbox.remove(item.id);
          }}
          className="h-8 shrink-0 rounded-md bg-red-600 px-2 text-xs font-medium text-white"
        >
          {t('voice.outbox.confirmDelete')}
        </button>
      ) : (
        <IconButton label={t('voice.outbox.delete')} onClick={() => setConfirming(true)} disabled={item.sending}>
          <Trash2 />
        </IconButton>
      )}
    </div>
  );
}

/**
 * GOLDJAXE fork (реестр §4.14): надиктовки, которые не дошли до распознавания.
 * Висит над полем ввода, пока очередь не пуста: обрыв связи не должен
 * выглядеть как «текста нет и непонятно почему». Удаление — в два касания:
 * это последняя копия речи.
 */
export default function VoiceOutboxNotice({ outbox }: { outbox: VoiceOutboxControls }) {
  if (outbox.items.length === 0) return null;
  return (
    <div className="space-y-1 rounded-xl border border-amber-500/30 bg-amber-500/10 px-2 py-1.5" role="status">
      {outbox.items.map((item) => (
        <OutboxRow key={item.id} item={item} outbox={outbox} />
      ))}
    </div>
  );
}
