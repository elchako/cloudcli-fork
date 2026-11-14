import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MailUploadRegistry, type MailUploadRecord } from '@/modules/assets/services/mail-upload-registry.service.js';
import { buildStoredAttachmentRecords } from '@/modules/assets/services/image-assets.service.js';

async function fixture(run: (f: { root: string; assets: string; directory: string; registry: MailUploadRegistry }) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-upload-registry-'));
  const assets = path.join(root, 'assets');
  const directory = path.join(root, 'registry');
  await mkdir(assets, { mode: 0o700 });
  try { await run({ root, assets, directory, registry: new MailUploadRegistry(directory, assets) }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
const file = { filename: 'actual-upload.png', originalname: 'Пользовательская картинка.png', mimetype: 'image/png' };
const content = Buffer.from('synthetic bytes, not a real image');
const active = () => true;
const register = (registry: MailUploadRegistry) => registry.registerUploads([file], '7', 1024, active);
async function readRecord(directory: string, id: string): Promise<MailUploadRecord> {
  return JSON.parse(await readFile(path.join(directory, `${id}.json`), 'utf8')) as MailUploadRecord;
}

test('exact протокол: UUIDv4 JSON, owner, настоящий размер/hash, 0700/0600 и отсутствие TTL/scope', async () => {
  await fixture(async ({ assets, directory, registry }) => {
    await writeFile(path.join(assets, file.filename), content);
    const [response] = (await register(registry))!;
    assert.match(response.mail_source_object_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const record = await readRecord(directory, response.mail_source_object_id);
    assert.deepEqual(Object.keys(record).sort(), ['asset_id', 'owner_user_id', 'origin', 'storage_name', 'filename', 'mime_type', 'size_bytes', 'sha256', 'created_at_ms', 'state', 'acl_version'].sort());
    assert.deepEqual({ ...record, asset_id: 'id', created_at_ms: 0 }, {
      asset_id: 'id', owner_user_id: '7', origin: 'user_upload', storage_name: file.filename, filename: file.originalname,
      mime_type: file.mimetype, size_bytes: content.length, sha256: createHash('sha256').update(content).digest('hex'),
      created_at_ms: 0, state: 'ready', acl_version: 1,
    });
    assert.equal(response.mail_sha256, record.sha256);
    assert.ok(record.created_at_ms > Date.now() - 10_000);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(directory, `${record.asset_id}.json`))).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(directory), [`${record.asset_id}.json`]);
  });
});

test('default off не читает даже отсутствующий asset и не создаёт записей', async () => {
  await fixture(async ({ assets, directory }) => {
    const registry = new MailUploadRegistry(undefined, assets);
    assert.equal(await register(registry), null);
    assert.equal(await registry.revoke(randomUUID(), '7', active), false);
    assert.equal(await lstat(directory).then(() => true, () => false), false);
  });
});

test('generated/старые файлы и построение chat descriptors не регистрируются автоматически', async () => {
  await fixture(async ({ assets, directory, registry }) => {
    await writeFile(path.join(assets, 'generated.png'), 'generated');
    buildStoredAttachmentRecords([{ filename: 'generated.png', originalname: 'generated.png', size: 9, mimetype: 'image/png' }]);
    assert.equal(await lstat(directory).then(() => true, () => false), false);
    await writeFile(path.join(assets, file.filename), content);
    await register(registry);
    assert.equal((await readdir(directory)).length, 1);
    const record = await readRecord(directory, (await readdir(directory))[0].slice(0, -5));
    assert.equal(record.storage_name, file.filename);
  });
});

for (const name of ['../outside', '/absolute', 'folder/file', 'folder\\file', '..', '.', '']) {
  test(`storage_name не допускает путь ${JSON.stringify(name)}`, async () => {
    await fixture(async ({ registry }) => {
      await assert.rejects(registry.registerUploads([{ ...file, filename: name }], '7', 1024, active), /Не удалось зарегистрировать загрузку для Mail/);
    });
  });
}

test('symlink и hardlink исходного файла отвергаются', async () => {
  for (const kind of ['symlink', 'hardlink']) await fixture(async ({ root, assets, registry }) => {
    const external = path.join(root, 'outside');
    await writeFile(external, content);
    if (kind === 'symlink') await symlink(external, path.join(assets, file.filename));
    else await link(external, path.join(assets, file.filename));
    await assert.rejects(register(registry), /Не удалось зарегистрировать загрузку для Mail/);
  });
});

test('symlink корня реестра и небезопасные права root отвергаются', async () => {
  await fixture(async ({ root, assets, directory, registry }) => {
    await writeFile(path.join(assets, file.filename), content);
    const other = path.join(root, 'other'); await mkdir(other, { mode: 0o700 });
    await symlink(other, directory);
    await assert.rejects(register(registry));
    assert.deepEqual(await readdir(other), []);
    await rm(directory); await mkdir(directory, { mode: 0o755 });
    await assert.rejects(register(registry));
    await chmod(directory, 0o700);
    assert.ok(await register(registry));
  });
});

test('проверяется фактический размер FD и отсутствие публикации при ошибке пачки', async () => {
  await fixture(async ({ assets, directory, registry }) => {
    await writeFile(path.join(assets, file.filename), content);
    await assert.rejects(registry.registerUploads([file], '7', content.length - 1, active));
    await assert.rejects(registry.registerUploads([file, { ...file, filename: 'missing.png' }], '7', 1024, active));
    assert.deepEqual(await readdir(directory), []);
    await mkdir(path.join(assets, 'directory.png'));
    await assert.rejects(registry.registerUploads([{ ...file, filename: 'directory.png' }], '7', 1024, active));
  });
});

test('owner inactive до или после вычисления hash не получает Mail record', async () => {
  await fixture(async ({ assets, directory, registry }) => {
    await writeFile(path.join(assets, file.filename), content);
    await assert.rejects(registry.registerUploads([file], '7', 1024, () => false));
    let checks = 0;
    await assert.rejects(registry.registerUploads([file], '7', 1024, () => ++checks === 1));
    assert.deepEqual(await readdir(directory), []);
  });
});

test('отзыв owner-scoped, атомарен, идемпотентен; файл чата не удаляется', async () => {
  await fixture(async ({ assets, directory, registry }) => {
    await writeFile(path.join(assets, file.filename), content);
    const id = (await register(registry))![0].mail_source_object_id;
    assert.equal(await registry.revoke(id, '8', active), false);
    assert.equal(await registry.revoke(randomUUID(), '8', active), false);
    assert.equal(await registry.revoke(id, '7', () => false), false);
    assert.equal((await readRecord(directory, id)).state, 'ready');
    await Promise.all(Array.from({ length: 8 }, () => registry.revoke(id, '7', active)));
    const record = await readRecord(directory, id);
    assert.equal(record.state, 'revoked'); assert.equal(record.acl_version, 2);
    assert.equal(await registry.revoke(id, '7', active), true);
    assert.equal((await readRecord(directory, id)).acl_version, 2);
    assert.deepEqual(await readFile(path.join(assets, file.filename)), content);
    assert.deepEqual(await readdir(directory), [`${id}.json`]);
  });
});

test('TTL capability/lease не относится к реестру: старая запись остаётся отзывной', async () => {
  await fixture(async ({ assets, directory, registry }) => {
    await writeFile(path.join(assets, file.filename), content);
    const id = (await register(registry))![0].mail_source_object_id;
    const record = await readRecord(directory, id);
    await writeFile(path.join(directory, `${id}.json`), JSON.stringify({ ...record, created_at_ms: 1 }), { mode: 0o600 });
    assert.equal(await registry.revoke(id, '7', active), true);
    assert.equal((await readRecord(directory, id)).created_at_ms, 1);
  });
});

test('отзыв не следует symlink/hardlink файла реестра и не принимает traversal asset_id', async () => {
  await fixture(async ({ root, assets, directory, registry }) => {
    await writeFile(path.join(assets, file.filename), content);
    const id = (await register(registry))![0].mail_source_object_id;
    const filename = path.join(directory, `${id}.json`);
    const saved = await readFile(filename);
    const outside = path.join(root, 'outside.json'); await writeFile(outside, saved, { mode: 0o600 });
    await rm(filename); await symlink(outside, filename);
    assert.equal(await registry.revoke(id, '7', active), false);
    await rm(filename); await link(outside, filename);
    assert.equal(await registry.revoke(id, '7', active), false);
    assert.equal(await registry.revoke('../outside', '7', active), false);
    assert.deepEqual(await readFile(outside), saved);
  });
});
