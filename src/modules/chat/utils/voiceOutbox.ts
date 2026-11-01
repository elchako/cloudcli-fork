/**
 * GOLDJAXE fork (реестр §4.14): очередь надиктовок в браузере.
 *
 * Раньше аудио жило только в памяти вкладки: обрыв связи на отправке, звонок
 * посреди распознавания или выгрузка вкладки системой стирали многоминутную
 * надиктовку без следа. Теперь запись ложится в IndexedDB по ходу диктовки —
 * чанк в секунду, — и пропасть может разве что последняя секунда речи.
 *
 * Механика повторяет очередь клиента diktor (`data/outbox`), только хранилище
 * браузерное. Здесь — хранение, замки записей между вкладками и оповещение
 * подписчиков; сеть и политика повторов — в `voiceDelivery.ts`.
 *
 * Очередь — страховка, а не критический путь: нет IndexedDB (старый браузер,
 * запрет хранилища) — работает та же логика в памяти вкладки. Тогда от обрыва
 * связи она ещё спасает, от перезагрузки страницы — уже нет.
 */

export type VoiceOutboxStatus = 'recording' | 'pending';

export type VoiceOutboxRecord = {
  id: string;
  createdAt: number;
  /** Обновляется каждым чанком — по нему видно, что запись ещё идёт. */
  updatedAt: number;
  mimeType: string;
  filename: string;
  /** `recording` — диктовка не закрыта: идёт сейчас или вкладка умерла посреди неё. */
  status: VoiceOutboxStatus;
  durationMs: number;
  size: number;
  attempts: number;
  lastError: string | null;
  lastAttemptAt: number | null;
  /** Повтор не поможет (неверный ключ, отказ сервера): фон запись не трогает, решает человек. */
  permanent: boolean;
};

export type NewVoiceOutboxRecord = Pick<VoiceOutboxRecord, 'id' | 'createdAt' | 'mimeType' | 'filename'>;

export type VoiceOutboxPatch = Partial<Omit<VoiceOutboxRecord, 'id' | 'createdAt'>>;

export type VoiceOutboxStore = {
  begin(record: NewVoiceOutboxRecord): Promise<void>;
  appendChunk(id: string, seq: number, data: Blob): Promise<void>;
  /** Подменяет все чанки записи одним куском — починка, если по ходу записи часть не легла. */
  replaceAudio(id: string, data: Blob): Promise<void>;
  get(id: string): Promise<VoiceOutboxRecord | null>;
  /** Записи от старых к новым: первой досылается самая старая. */
  list(): Promise<VoiceOutboxRecord[]>;
  readAudio(id: string): Promise<Blob | null>;
  update(id: string, patch: VoiceOutboxPatch): Promise<void>;
  remove(id: string): Promise<void>;
  /** Чанки без записи — остаток прерванного удаления. Возвращает число удалённых записей-сирот. */
  removeOrphanChunks(): Promise<number>;
};

function newRecord(record: NewVoiceOutboxRecord): VoiceOutboxRecord {
  return {
    ...record,
    updatedAt: record.createdAt,
    status: 'recording',
    durationMs: 0,
    size: 0,
    attempts: 0,
    lastError: null,
    lastAttemptAt: null,
    permanent: false,
  };
}

const byAge = (a: VoiceOutboxRecord, b: VoiceOutboxRecord) => a.createdAt - b.createdAt;

/** «5:12» — длина надиктовки для подписей. */
export function formatVoiceDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

//----------------- ХРАНИЛИЩЕ В ПАМЯТИ ------------

/** Запасной вариант без IndexedDB и хранилище для тестов. */
export function createMemoryVoiceOutboxStore(): VoiceOutboxStore {
  const records = new Map<string, VoiceOutboxRecord>();
  const chunks = new Map<string, Map<number, Blob>>();

  const chunksOf = (id: string) => {
    let map = chunks.get(id);
    if (!map) {
      map = new Map();
      chunks.set(id, map);
    }
    return map;
  };

  return {
    async begin(record) {
      records.set(record.id, newRecord(record));
    },
    async appendChunk(id, seq, data) {
      chunksOf(id).set(seq, data);
      const record = records.get(id);
      if (record) records.set(id, { ...record, size: record.size + data.size, updatedAt: Date.now() });
    },
    async replaceAudio(id, data) {
      chunks.set(id, new Map([[0, data]]));
      const record = records.get(id);
      if (record) records.set(id, { ...record, size: data.size, updatedAt: Date.now() });
    },
    async get(id) {
      const record = records.get(id);
      return record ? { ...record } : null;
    },
    async list() {
      return [...records.values()].map((record) => ({ ...record })).sort(byAge);
    },
    async readAudio(id) {
      const record = records.get(id);
      const parts = chunks.get(id);
      if (!record || !parts || parts.size === 0) return null;
      const ordered = [...parts.entries()].sort(([a], [b]) => a - b).map(([, blob]) => blob);
      return new Blob(ordered, { type: record.mimeType });
    },
    async update(id, patch) {
      const record = records.get(id);
      if (record) records.set(id, { ...record, ...patch });
    },
    async remove(id) {
      records.delete(id);
      chunks.delete(id);
    },
    async removeOrphanChunks() {
      let removed = 0;
      for (const id of chunks.keys()) {
        if (!records.has(id)) {
          chunks.delete(id);
          removed += 1;
        }
      }
      return removed;
    },
  };
}

//----------------- ХРАНИЛИЩЕ В INDEXEDDB ------------

const DB_NAME = 'cloudcli-voice-outbox';
const DB_VERSION = 1;
const RECORDS = 'records';
const CHUNKS = 'chunks';

type StoredChunk = { recordingId: string; seq: number; data: ArrayBuffer };

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RECORDS)) db.createObjectStore(RECORDS, { keyPath: 'id' });
      // Составной ключ [запись, номер чанка]: чанки одной записи лежат подряд и
      // читаются одним диапазоном уже в нужном порядке.
      if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS, { keyPath: ['recordingId', 'seq'] });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

const chunkRange = (id: string) => IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);

/**
 * Хранилище в IndexedDB. Аудио кладётся как ArrayBuffer, а не Blob: старые
 * Safari не умели хранить Blob в IndexedDB, буфер работает везде.
 *
 * Не открылась база — все вызовы молча уходят в хранилище в памяти: отказать
 * человеку в диктовке из-за сбоя страховки было бы хуже, чем остаться без неё.
 */
export function createIndexedDbVoiceOutboxStore(): VoiceOutboxStore {
  const memory = createMemoryVoiceOutboxStore();
  let dbPromise: Promise<IDBDatabase | null> | null = null;

  const database = () => {
    if (!dbPromise) {
      dbPromise = openDatabase().catch((error) => {
        console.warn('[voice-outbox] IndexedDB unavailable, queue lives in memory only:', error);
        return null;
      });
    }
    return dbPromise;
  };

  return {
    async begin(record) {
      const db = await database();
      if (!db) return memory.begin(record);
      const tx = db.transaction(RECORDS, 'readwrite');
      tx.objectStore(RECORDS).put(newRecord(record));
      await transactionDone(tx);
    },

    async appendChunk(id, seq, blob) {
      const db = await database();
      if (!db) return memory.appendChunk(id, seq, blob);
      // Буфер читаем ДО открытия транзакции: на любом await внутри неё
      // IndexedDB закрыл бы транзакцию.
      const data = await blob.arrayBuffer();
      const tx = db.transaction([RECORDS, CHUNKS], 'readwrite');
      const records = tx.objectStore(RECORDS);
      tx.objectStore(CHUNKS).put({ recordingId: id, seq, data } satisfies StoredChunk);
      const current = records.get(id);
      current.onsuccess = () => {
        const record = current.result as VoiceOutboxRecord | undefined;
        if (record) records.put({ ...record, size: record.size + data.byteLength, updatedAt: Date.now() });
      };
      await transactionDone(tx);
    },

    async replaceAudio(id, blob) {
      const db = await database();
      if (!db) return memory.replaceAudio(id, blob);
      const data = await blob.arrayBuffer();
      const tx = db.transaction([RECORDS, CHUNKS], 'readwrite');
      const records = tx.objectStore(RECORDS);
      const chunks = tx.objectStore(CHUNKS);
      chunks.delete(chunkRange(id));
      chunks.put({ recordingId: id, seq: 0, data } satisfies StoredChunk);
      const current = records.get(id);
      current.onsuccess = () => {
        const record = current.result as VoiceOutboxRecord | undefined;
        if (record) records.put({ ...record, size: data.byteLength, updatedAt: Date.now() });
      };
      await transactionDone(tx);
    },

    async get(id) {
      const db = await database();
      if (!db) return memory.get(id);
      const record = await requestResult(db.transaction(RECORDS).objectStore(RECORDS).get(id));
      return (record as VoiceOutboxRecord | undefined) ?? null;
    },

    async list() {
      const db = await database();
      if (!db) return memory.list();
      const records = await requestResult(db.transaction(RECORDS).objectStore(RECORDS).getAll());
      return (records as VoiceOutboxRecord[]).sort(byAge);
    },

    async readAudio(id) {
      const db = await database();
      if (!db) return memory.readAudio(id);
      const tx = db.transaction([RECORDS, CHUNKS]);
      const [record, chunks] = await Promise.all([
        requestResult(tx.objectStore(RECORDS).get(id)),
        requestResult(tx.objectStore(CHUNKS).getAll(chunkRange(id))),
      ]);
      const parts = chunks as StoredChunk[];
      if (!record || parts.length === 0) return null;
      return new Blob(parts.map((chunk) => chunk.data), { type: (record as VoiceOutboxRecord).mimeType });
    },

    async update(id, patch) {
      const db = await database();
      if (!db) return memory.update(id, patch);
      const tx = db.transaction(RECORDS, 'readwrite');
      const records = tx.objectStore(RECORDS);
      const current = records.get(id);
      current.onsuccess = () => {
        const record = current.result as VoiceOutboxRecord | undefined;
        if (record) records.put({ ...record, ...patch });
      };
      await transactionDone(tx);
    },

    async remove(id) {
      const db = await database();
      if (!db) return memory.remove(id);
      const tx = db.transaction([RECORDS, CHUNKS], 'readwrite');
      tx.objectStore(RECORDS).delete(id);
      tx.objectStore(CHUNKS).delete(chunkRange(id));
      await transactionDone(tx);
    },

    async removeOrphanChunks() {
      const db = await database();
      if (!db) return memory.removeOrphanChunks();
      // Оба списка ключей — из одной транзакции, то есть из одного снимка: запись,
      // созданная позже, не попадёт в сироты, ведь её чанков в снимке ещё нет.
      const read = db.transaction([RECORDS, CHUNKS]);
      const [recordKeys, chunkKeys] = await Promise.all([
        requestResult(read.objectStore(RECORDS).getAllKeys()),
        requestResult(read.objectStore(CHUNKS).getAllKeys()),
      ]);
      const known = new Set(recordKeys.map(String));
      const orphans = new Set<string>();
      for (const key of chunkKeys) {
        const recordingId = String((key as [string, number])[0]);
        if (!known.has(recordingId)) orphans.add(recordingId);
      }
      if (orphans.size === 0) return 0;
      const tx = db.transaction(CHUNKS, 'readwrite');
      for (const id of orphans) tx.objectStore(CHUNKS).delete(chunkRange(id));
      await transactionDone(tx);
      return orphans.size;
    },
  };
}

let activeStore: VoiceOutboxStore | null = null;

/** Хранилище очереди вкладки: IndexedDB, где он есть, иначе память. */
export function getVoiceOutboxStore(): VoiceOutboxStore {
  if (!activeStore) {
    activeStore = typeof indexedDB === 'undefined'
      ? createMemoryVoiceOutboxStore()
      : createIndexedDbVoiceOutboxStore();
  }
  return activeStore;
}

export function setVoiceOutboxStoreForTests(store: VoiceOutboxStore | null): void {
  activeStore = store;
}

//----------------- ОПОВЕЩЕНИЕ ------------

const listeners = new Set<() => void>();

export function subscribeVoiceOutbox(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyVoiceOutboxChanged(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      /* подписчик не должен ронять остальных */
    }
  }
}

//----------------- ЗАМКИ ЗАПИСЕЙ ------------

// Одну запись не должны одновременно трогать две вкладки (или запись и фоновый
// досыльщик в одной): иначе её распознают дважды и текст вставится два раза.
// Web Locks снимает замок сам, когда вкладка умирает, — поэтому запись,
// брошенная посреди диктовки, освобождается и подхватывается при следующем
// открытии. Внутри вкладки дублирует обычное множество: оно же работает там,
// где Web Locks нет.
const LOCK_PREFIX = 'cloudcli-voice-outbox:';
const heldInTab = new Set<string>();

function lockManager(): LockManager | null {
  if (typeof navigator === 'undefined') return null;
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  return locks && typeof locks.request === 'function' ? locks : null;
}

/** Есть ли межвкладочные замки. Без них брошенную запись узнают по возрасту. */
export function hasCrossTabLocks(): boolean {
  return lockManager() !== null;
}

/** Держит ли эта вкладка запись прямо сейчас (пишет или отправляет её). */
export function isVoiceRecordHeldHere(id: string): boolean {
  return heldInTab.has(id);
}

/**
 * Захватывает замок записи на всё время, пока вкладка её пишет и отправляет.
 * Возвращает функцию освобождения; повторный вызов освобождения безвреден.
 */
export function holdVoiceRecordLock(id: string): Promise<() => void> {
  heldInTab.add(id);
  let releaseLock: () => void = () => {};
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    heldInTab.delete(id);
    releaseLock();
  };
  const locks = lockManager();
  if (!locks) return Promise.resolve(release);
  return new Promise((resolve) => {
    locks
      .request(LOCK_PREFIX + id, () => new Promise<void>((done) => {
        releaseLock = done;
        resolve(release);
      }))
      .catch(() => resolve(release));
  });
}

/**
 * Выполняет `work` под замком записи, если он свободен; занят — не ждёт.
 * Занят он, когда запись пишет или отправляет другая вкладка либо эта же.
 */
export async function withVoiceRecordLock<T>(
  id: string,
  work: () => Promise<T>,
): Promise<{ acquired: false } | { acquired: true; value: T }> {
  if (heldInTab.has(id)) return { acquired: false };
  heldInTab.add(id);
  try {
    const locks = lockManager();
    if (!locks) return { acquired: true, value: await work() };
    let outcome: { acquired: false } | { acquired: true; value: T } = { acquired: false };
    await locks.request(LOCK_PREFIX + id, { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      outcome = { acquired: true, value: await work() };
    });
    return outcome;
  } finally {
    heldInTab.delete(id);
  }
}
