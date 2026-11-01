import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  flushVoiceOutbox,
  getVoiceOutboxSendingIds,
  VOICE_ORPHAN_AFTER_MS,
  VOICE_OUTBOX_FLUSH_INTERVAL_MS,
  type VoiceOutboxDeliver,
} from '@/modules/chat/utils/voiceDelivery';
import {
  getVoiceOutboxStore,
  isVoiceRecordHeldHere,
  notifyVoiceOutboxChanged,
  subscribeVoiceOutbox,
  withVoiceRecordLock,
  type VoiceOutboxRecord,
} from '@/modules/chat/utils/voiceOutbox';

/** Пауза перед первой досылкой после монтирования: дать приложению подняться. */
const INITIAL_FLUSH_DELAY_MS = 1500;

export type VoiceOutboxItem = VoiceOutboxRecord & { sending: boolean };

export type VoiceOutboxControls = {
  /** Надиктовки, которые ждут отправки (без той, что эта вкладка пишет прямо сейчас). */
  items: VoiceOutboxItem[];
  sendNow: (id: string) => void;
  remove: (id: string) => Promise<void>;
  download: (id: string) => Promise<void>;
};

function downloadName(record: VoiceOutboxRecord): string {
  const stamp = new Date(record.createdAt);
  const pad = (value: number) => String(value).padStart(2, '0');
  const ext = record.filename.split('.').pop() || 'webm';
  return `dictation-${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}.${ext}`;
}

/**
 * GOLDJAXE fork (реестр §4.14): очередь надиктовок для композера — список
 * отложенных записей, кнопки к ним и фоновая досылка.
 *
 * Досылка идёт, только пока `enabled`: голос доступен и композер простаивает.
 * Пока человек диктует или ждёт текст, канал и внимание принадлежат текущей
 * диктовке — фон со своим запросом не влезает (как в diktor). Поводы
 * дослать: монтирование (запись, брошенная перезагрузкой страницы), `online`,
 * возврат на вкладку и таймер, пока в очереди есть что слать.
 */
export function useVoiceOutbox({
  enabled,
  deliver,
}: {
  enabled: boolean;
  deliver: VoiceOutboxDeliver;
}): VoiceOutboxControls {
  const [snapshot, setSnapshot] = useState<{
    records: VoiceOutboxRecord[];
    sending: ReadonlySet<string>;
    listedAt: number;
  }>(() => ({ records: [], sending: new Set(), listedAt: 0 }));
  const deliverRef = useRef(deliver);
  useEffect(() => {
    deliverRef.current = deliver;
  });

  useEffect(() => {
    let active = true;
    const refresh = () => {
      getVoiceOutboxStore()
        .list()
        .then((records) => {
          if (!active) return;
          setSnapshot({ records, sending: new Set(getVoiceOutboxSendingIds()), listedAt: Date.now() });
        })
        .catch(() => {});
    };
    refresh();
    const unsubscribe = subscribeVoiceOutbox(refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const flush = useCallback((options?: { onlyId?: string; force?: boolean }) => (
    flushVoiceOutbox((text, record) => deliverRef.current(text, record), options)
  ), []);

  useEffect(() => {
    if (!enabled) return undefined;
    const kick = () => {
      void flush();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') kick();
    };
    const initial = setTimeout(kick, INITIAL_FLUSH_DELAY_MS);
    window.addEventListener('online', kick);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearTimeout(initial);
      window.removeEventListener('online', kick);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, flush]);

  const { records, sending, listedAt } = snapshot;

  // Таймер — только пока есть что досылать: пустая очередь не будит вкладку.
  const hasRetryable = records.some((record) => !record.permanent && !isVoiceRecordHeldHere(record.id));
  useEffect(() => {
    if (!enabled || !hasRetryable) return undefined;
    const timer = setInterval(() => {
      if (typeof navigator === 'undefined' || navigator.onLine !== false) void flush();
    }, VOICE_OUTBOX_FLUSH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [enabled, hasRetryable, flush]);

  const items = useMemo<VoiceOutboxItem[]>(() => (
    records
      .filter((record) => {
        if (sending.has(record.id)) return true;
        // Запись, которую эта вкладка пишет или отправляет сразу после диктовки,
        // — ещё не «отложенная»: её состояние показывает сама кнопка микрофона.
        if (isVoiceRecordHeldHere(record.id)) return false;
        // Свежие чанки — запись идёт в другой вкладке, это тоже не отложенная.
        return !(record.status === 'recording' && listedAt - record.updatedAt < VOICE_ORPHAN_AFTER_MS);
      })
      .map((record) => ({ ...record, sending: sending.has(record.id) }))
  ), [records, sending, listedAt]);

  const sendNow = useCallback((id: string) => {
    void flush({ onlyId: id, force: true });
  }, [flush]);

  const remove = useCallback(async (id: string) => {
    await withVoiceRecordLock(id, () => getVoiceOutboxStore().remove(id));
    notifyVoiceOutboxChanged();
  }, []);

  const download = useCallback(async (id: string) => {
    const store = getVoiceOutboxStore();
    const [record, audio] = await Promise.all([store.get(id), store.readAudio(id)]);
    if (!record || !audio) return;
    const url = URL.createObjectURL(audio);
    const link = document.createElement('a');
    link.href = url;
    link.download = downloadName(record);
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Мобильный Chrome забирает файл асинхронно: ссылку держим, пока не скачает.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }, []);

  return { items, sendNow, remove, download };
}
