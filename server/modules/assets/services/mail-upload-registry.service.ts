// GOLDJAXE fork (реестр §24): происхождение только authenticated multipart upload.
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import { z } from 'zod';

import { getGlobalImageAssetsDir } from '@/shared/image-attachments.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const storageName = z.string().regex(/^[A-Za-z0-9_.-]+$/).refine(name => name !== '.' && name !== '..');
const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const recordSchema = z.object({
  asset_id: z.string().regex(UUID_V4), owner_user_id: z.string().min(1), origin: z.literal('user_upload'),
  storage_name: storageName, filename: z.string(), mime_type: z.string(), size_bytes: safeInteger,
  sha256: z.string().regex(/^[a-f0-9]{64}$/), created_at_ms: safeInteger,
  state: z.enum(['ready', 'revoked']), acl_version: safeInteger.refine(value => value >= 1),
}).strict();

export type MailUploadRecord = z.infer<typeof recordSchema>;
export type MailUploadResponse = { mail_source_object_id: string; mail_sha256: string };
type UploadedFile = { filename: string; originalname: string; mimetype: string };
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** Linux: операции привязаны к открытому inode каталога, не к повторному разрешению пути. */
const at = (directory: FileHandle, name: string) => `/proc/self/fd/${directory.fd}/${name}`;

async function openOwnedDirectory(directory: string, privateMode: boolean): Promise<FileHandle> {
  const handle = await open(path.resolve(directory), READ_FLAGS | constants.O_DIRECTORY);
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (privateMode && (stat.mode & 0o777) !== 0o700)) {
      throw new Error('Unsafe directory');
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

/** Реестр не принимает пути от модели. Вызывается только upload routes после multer. */
export class MailUploadRegistry {
  constructor(private readonly directory?: string, private readonly assetsDirectory = getGlobalImageAssetsDir()) {}

  get enabled(): boolean { return Boolean(this.directory); }

  async #root(): Promise<FileHandle> {
    if (!this.directory || !path.isAbsolute(this.directory)) throw new Error('Invalid registry directory');
    try { await mkdir(this.directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    return openOwnedDirectory(this.directory, true);
  }

  async #atomicWrite(root: FileHandle, record: MailUploadRecord): Promise<void> {
    const temporary = at(root, `.pending-${randomUUID()}.tmp`);
    const target = at(root, `${record.asset_id}.json`);
    let created = false;
    try {
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      try {
        await file.chmod(0o600);
        await file.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
        await file.sync();
      } finally { await file.close(); }
      await rename(temporary, target);
      await root.sync();
    } finally {
      if (created) await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    }
  }

  async #snapshot(assets: FileHandle, file: UploadedFile, maxBytes: number) {
    const name = storageName.parse(file.filename);
    const source = await open(at(assets, name), READ_FLAGS);
    try {
      const before = await source.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) throw new Error('Invalid uploaded file');
      const hash = createHash('sha256');
      let size = 0;
      for await (const chunk of source.createReadStream({ autoClose: false })) {
        size += chunk.length;
        if (size > maxBytes) throw new Error('Uploaded file too large');
        hash.update(chunk);
      }
      const after = await source.stat();
      if (!after.isFile() || after.nlink !== 1 || before.size !== size || after.size !== size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Uploaded file changed');
      return { size_bytes: size, sha256: hash.digest('hex') };
    } finally { await source.close(); }
  }

  async registerUploads(files: UploadedFile[], ownerUserId: string, maxBytes: number, ownerStillActive: () => boolean): Promise<MailUploadResponse[] | null> {
    if (!this.enabled) return null; // прежний upload без записей и без доступа к реестру
    let root: FileHandle | undefined;
    let assets: FileHandle | undefined;
    const published: string[] = [];
    try {
      if (!ownerUserId || !ownerStillActive() || !Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('Invalid owner');
      root = await this.#root();
      assets = await openOwnedDirectory(this.assetsDirectory, false);
      const records: MailUploadRecord[] = [];
      for (const file of files) {
        const snapshot = await this.#snapshot(assets, file, maxBytes);
        records.push(recordSchema.parse({
          asset_id: randomUUID(), owner_user_id: ownerUserId, origin: 'user_upload', storage_name: file.filename,
          filename: file.originalname, mime_type: file.mimetype, ...snapshot,
          created_at_ms: Date.now(), state: 'ready', acl_version: 1,
        }));
      }
      // Hash получен асинхронно, активность владельца перепроверяется перед публикацией.
      for (const record of records) {
        if (!ownerStillActive()) throw new Error('Inactive owner');
        await this.#atomicWrite(root, record);
        published.push(record.asset_id);
      }
      if (!ownerStillActive()) throw new Error('Inactive owner');
      return records.map(record => ({ mail_source_object_id: record.asset_id, mail_sha256: record.sha256 }));
    } catch {
      // При ошибке пачки не оставляем частично зарегистрированные Mail-вложения.
      if (root) for (const id of published) await unlink(at(root, `${id}.json`)).catch(() => {});
      throw new Error('Не удалось зарегистрировать загрузку для Mail');
    } finally { await assets?.close(); await root?.close(); }
  }

  /** Отзыв только Mail-экспорта; исходный файл чата никогда не удаляется. */
  async revoke(assetId: string, ownerUserId: string, ownerStillActive: () => boolean): Promise<boolean> {
    if (!this.enabled || !UUID_V4.test(assetId) || !ownerUserId || !ownerStillActive()) return false;
    let root: FileHandle | undefined;
    try {
      root = await this.#root();
      let record: MailUploadRecord;
      try {
        const source = await open(at(root, `${assetId}.json`), READ_FLAGS);
        try {
          const stat = await source.stat();
          if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.()
            || (stat.mode & 0o777) !== 0o600 || stat.size > 64 * 1024) return false;
          record = recordSchema.parse(JSON.parse(await source.readFile('utf8')));
        } finally { await source.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ELOOP') return false;
        throw error;
      }
      if (record.asset_id !== assetId || record.owner_user_id !== ownerUserId || !ownerStillActive()) return false;
      if (record.state === 'revoked') return true; // идемпотентный повтор без лишней смены версии
      const next = recordSchema.parse({ ...record, state: 'revoked', acl_version: record.acl_version + 1 });
      await this.#atomicWrite(root, next);
      return true;
    } catch {
      throw new Error('Не удалось отозвать загрузку для Mail');
    } finally { await root?.close(); }
  }
}

export const mailUploadRegistry = new MailUploadRegistry(process.env.CLOUDCLI_MAIL_UPLOADS_DIR);
