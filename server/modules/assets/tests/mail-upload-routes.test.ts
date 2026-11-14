import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';
// @ts-expect-error В проекте jsonwebtoken установлен без @types; используется только синтетический JWT.
import jwt from 'jsonwebtoken';

// Изолированные БД/реестр до импорта route singleton. Ни одного настоящего JWT/файла.
const root = await mkdtemp(path.join(os.tmpdir(), 'mail-upload-routes-'));
process.env.JWT_SECRET = 'synthetic-upload-route-test-secret-not-used-outside-test';
process.env.DATABASE_PATH = path.join(root, 'auth.db');
process.env.CLOUDCLI_MAIL_UPLOADS_DIR = path.join(root, 'registry');
const { initializeDatabase, closeConnection, getConnection, userDb } = await import('@/modules/database/index.js');
await initializeDatabase();
const owner = userDb.createUser('synthetic-owner', 'not-a-real-password');
const foreign = userDb.createUser('synthetic-foreign', 'not-a-real-password');
const { authenticateToken } = await import('@/modules/auth/index.js');
const { default: router } = await import('@/modules/assets/assets.routes.js');
const app = express();
app.use('/api/assets', authenticateToken, router);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address === 'object');
const url = `http://127.0.0.1:${address.port}/api/assets`;
const ownerToken = jwt.sign({ userId: Number(owner.id) }, process.env.JWT_SECRET, { expiresIn: '1h' });
const foreignToken = jwt.sign({ userId: Number(foreign.id) }, process.env.JWT_SECRET, { expiresIn: '1h' });
const created: string[] = [];
test.after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  closeConnection();
  for (const filename of created) await rm(filename, { force: true });
  await rm(root, { recursive: true, force: true });
});

type UploadedAsset = { path: string; mail_source_object_id: string; mail_sha256: string };

async function upload(endpoint: 'images' | 'files', token?: string) {
  const form = new FormData();
  form.append(endpoint, new Blob(['synthetic-user-upload'], { type: endpoint === 'images' ? 'image/png' : 'application/pdf' }), endpoint === 'images' ? 'picture.png' : 'document.pdf');
  form.append('owner_user_id', String(foreign.id));
  form.append('scope', 'model-supplied-scope-is-ignored');
  return fetch(`${url}/${endpoint}`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: form });
}
async function record(id: string) {
  return JSON.parse(await readFile(path.join(root, 'registry', `${id}.json`), 'utf8'));
}

for (const endpoint of ['images', 'files'] as const) {
  test(`POST ${endpoint}: настоящий multipart+JWT, owner из auth, дополнительные поля ответа`, async () => {
    const res = await upload(endpoint, ownerToken);
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, UploadedAsset[]>;
    const attachment = body[endpoint === 'images' ? 'images' : 'attachments'][0];
    created.push(attachment.path);
    const meta = await record(attachment.mail_source_object_id);
    assert.equal(meta.owner_user_id, String(owner.id));
    assert.equal(meta.origin, 'user_upload');
    assert.equal(meta.storage_name, path.basename(attachment.path));
    assert.equal(meta.filename, endpoint === 'images' ? 'picture.png' : 'document.pdf');
    assert.equal(meta.mime_type, endpoint === 'images' ? 'image/png' : 'application/pdf');
    assert.equal(meta.size_bytes, Buffer.byteLength('synthetic-user-upload'));
    assert.equal(meta.sha256, createHash('sha256').update('synthetic-user-upload').digest('hex'));
    assert.equal(attachment.mail_sha256, meta.sha256);
    assert.equal(meta.scope, undefined);
    assert.equal(meta.state, 'ready');
  });
}

test('чужой и неизвестный asset одинаково 404; owner DELETE отзывает Mail, но оставляет файл чата', async () => {
  const res = await upload('files', ownerToken);
  const attachment = (await res.json() as { attachments: UploadedAsset[] }).attachments[0]; created.push(attachment.path);
  const id = attachment.mail_source_object_id;
  const foreignResponse = await fetch(`${url}/mail-uploads/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${foreignToken}` } });
  const unknownResponse = await fetch(`${url}/mail-uploads/${randomUUID()}`, { method: 'DELETE', headers: { Authorization: `Bearer ${foreignToken}` } });
  assert.equal(foreignResponse.status, 404); assert.equal(unknownResponse.status, 404);
  assert.deepEqual(await foreignResponse.json(), await unknownResponse.json());
  assert.equal((await record(id)).state, 'ready');
  const revoked = await fetch(`${url}/mail-uploads/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${ownerToken}` } });
  assert.equal(revoked.status, 204);
  assert.equal((await record(id)).state, 'revoked'); assert.equal((await record(id)).acl_version, 2);
  assert.equal(await readFile(attachment.path, 'utf8'), 'synthetic-user-upload');
  const download = await fetch(`${url}/files/${encodeURIComponent(path.basename(attachment.path))}`, { headers: { Authorization: `Bearer ${ownerToken}` } });
  assert.equal(download.status, 200); assert.equal(await download.text(), 'synthetic-user-upload');
});

test('нет JWT или учётка уже inactive: upload/revoke закрыты до работы с файлами', async () => {
  const before = (await readdir(path.join(root, 'registry'))).sort();
  assert.equal((await upload('files')).status, 401);
  getConnection().prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(foreign.id);
  assert.equal((await upload('files', foreignToken)).status, 401);
  assert.equal((await fetch(`${url}/mail-uploads/${randomUUID()}`, { method: 'DELETE', headers: { Authorization: `Bearer ${foreignToken}` } })).status, 401);
  assert.deepEqual((await readdir(path.join(root, 'registry'))).sort(), before);
});
