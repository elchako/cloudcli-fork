import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants, createCipheriv, createPublicKey, publicEncrypt, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import * as tls from 'node:tls';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { chatDestinationPreview, parseChatDestination, type ConfirmDelivery } from '../chat-destination.js';
import { createProtectedDataMcp } from '../mcp.js';
import { protectedDataAad, type ProtectedDataProfile } from '../protocol.js';
import { createProtectedDataRelay } from '../relay.js';

const marker = 'synthetic-one-turn-value';
function seal(profile: ProtectedDataProfile, target: string) {
  const meta = { version: 1 as const, revision: profile.revision, sessionId: 'delivery-test', nonce: randomUUID(), issuedAt: Date.now(), names: ['SMS_KEY', 'OTHER'], target };
  const iv = randomBytes(12);
  const key = randomBytes(32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(protectedDataAad(meta));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify([marker, 'unused-value'])), cipher.final(), cipher.getAuthTag()]);
  const publicKey = createPublicKey({ key: Buffer.from(profile.publicKey, 'base64'), format: 'der', type: 'spki' });
  const wrappedKey = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  return { ...meta, iv: iv.toString('base64'), wrappedKey: wrappedKey.toString('base64'), ciphertext: ciphertext.toString('base64') };
}

async function turn(t: TestContext, confirm?: ConfirmDelivery, target = 'chat-destination', root = '/test/project') {
  const relay = createProtectedDataRelay({ mode: 'memory' });
  const profile = await relay.getProfile();
  assert.ok(profile);
  const envelope = seal(profile, target);
  const id = await relay.stage('user-A', envelope);
  const writer = { send: () => {} };
  assert.ok(relay.prepare('user-A', envelope.sessionId, id, root)?.(writer));
  const grant = relay.take(writer);
  assert.ok(grant);
  let executed = 0;
  const mcp = createProtectedDataMcp(grant, () => relay.isActive(writer), (...args) => { executed++; return relay.execute(...args); }, confirm);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await mcp.server.instance.connect(b);
  await client.connect(a);
  t.after(async () => { mcp.revoke(); await client.close(); await mcp.server.instance.close(); });
  const call = (destination: string, fields = ['SMS_KEY']) => client.callTool({ name: 'deliver_protected_fields', arguments: { destination, fields } });
  return { call, client, envelope, relay, revoke: () => relay.forget(writer), executions: () => executed };
}

test('предложение канонично: команда, пароль, обход каталога и подмена адреса отвергаются', () => {
  const ssh = parseChatDestination('ssh://service@10.0.0.9:2222/etc/example/service.env');
  assert.ok(ssh);
  assert.equal(chatDestinationPreview(ssh), 'Файл окружения systemd на VPS: ssh://service@10.0.0.9:2222/etc/example/service.env');
  assert.ok(parseChatDestination('ssh://user@[::1]/config/.env'));
  assert.ok(parseChatDestination('project:config/.env.production'));
  for (const input of ['project:/etc/other.env', 'project:../escape.env', 'project:.git/w.env', 'ssh://-oProxyCommand/etc/x.env',
    'ssh://a:pass@b/etc/x.env', 'ssh://host/etc/../x.env', 'ssh://host/etc/authorized_keys', 'ssh://host/etc/var.env\n',
    'https://intended@other.example/', 'https://site.example/a/../b', 'https://site.example/%2fsecret', 'https://site.example/a?secret=X', 'http://host/x']) {
    assert.equal(parseChatDestination(input), null, input);
  }
});

test('без привязки к новому ходу и отдельного согласия нет исполнения; нельзя повысить права старого вложения', async t => {
  const no = await turn(t, async () => false);
  assert.equal(await no.relay.execute(no.envelope), 'invalid');
  assert.ok((await no.call('ssh://example.test/etc/test.env')).isError);
  assert.equal(no.executions(), 0);
  assert.ok((await no.call('https://elsewhere.test/keys')).isError);
  const old = await turn(t, async () => true, 'project-env');
  assert.deepEqual((await old.client.listTools()).tools.map(t => t.name), ['apply_protected_field']);
  assert.ok((await old.call('ssh://elsewhere.test/etc/test.env')).isError);
  assert.equal(old.executions(), 0);
});

test('отзыв во время карточки и параллельный второй адрес не разрешают доставку', async t => {
  let showing!: () => void;
  const shown = new Promise<void>(resolve => { showing = resolve; });
  let answer!: () => void;
  const decision = new Promise<void>(resolve => { answer = resolve; });
  let prompts = 0;
  const app = await turn(t, async (_dest, _fields, signal) => { prompts++; showing(); await decision; assert.equal(signal.aborted, true); return true; });
  const first = app.call('ssh://host.test/etc/a.env');
  await shown;
  assert.ok((await app.call('ssh://other.test/etc/b.env')).isError);
  app.revoke(); answer();
  assert.ok((await first).isError); assert.equal(prompts, 1); assert.equal(app.executions(), 0);
});

test('подтверждённый файл в подкаталоге проекта получает одно выбранное поле, а не весь набор', async t => {
  const root = await mkdtemp(join(tmpdir(), 'chat-project-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  const subdir = join(root, 'config'); await mkdir(subdir, { mode: 0o700 });
  await writeFile(join(root, '.gitignore'), '*.env\n');
  const file = join(subdir, 'service.env'); await writeFile(file, 'KEEP=yes\n', { mode: 0o600 });
  const app = await turn(t, async (preview, names) => {
    assert.equal(preview, `Локальный файл проекта: ${file}`);
    assert.deepEqual(names, ['SMS_KEY']); return true;
  }, 'chat-destination', root);
  const result = await app.call('project:config/service.env');
  assert.equal(result.isError, false); assert.ok(!JSON.stringify(result).includes(marker));
  assert.equal(await readFile(file, 'utf8'), `KEEP=yes\nSMS_KEY="${marker}"\n`);
});

test('TLS на loopback: до согласия нет запроса; только выбранное поле, ответ не отражается, 307 не переносит значение', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-tls-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cert = join(dir, 'server.pem'); const key = join(dir, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert], { stdio: 'ignore' });
  const pem = await readFile(cert, 'utf8');
  const requests: Array<{ path: string; body: unknown }> = [];
  const server = createServer({ key: await readFile(key), cert: pem }, async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    requests.push({ path: req.url!, body: JSON.parse(body) });
    if (req.url === '/redirect') res.writeHead(307, { location: '/not-approved' });
    res.end(marker);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const untrusted = await turn(t, async () => true); assert.ok((await untrusted.call(`${base}/keys`)).isError);
  assert.equal(requests.length, 0);
  const old = tls.getCACertificates(); tls.setDefaultCACertificates([...old, pem]);
  t.after(() => tls.setDefaultCACertificates(old));
  for (const path of ['/keys', '/redirect']) {
    const before: number = requests.length;
    const app = await turn(t, async (preview, names) => {
      assert.equal(requests.length, before);
      assert.equal(preview, `HTTPS POST · JSON с выбранными полями → ${base}${path}`);
      assert.deepEqual(names, ['SMS_KEY']); return true;
    });
    assert.ok((await app.call(`${base}${path}`, ['MISSING'])).isError);
    const result = await app.call(`${base}${path}`);
    assert.equal(Boolean(result.isError), path !== '/keys'); assert.ok(!JSON.stringify(result).includes(marker));
    assert.equal(app.executions(), 1); assert.equal(requests.length, before + 1);
    assert.deepEqual(requests.at(-1), { path, body: { SMS_KEY: marker } });
  }
});
