import { Buffer } from 'node:buffer';
import { constants, createDecipheriv, createPrivateKey, createPublicKey, privateDecrypt, randomBytes, type KeyObject } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, closeSync, constants as fsConstants, fstatSync, openSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { dirname, isAbsolute } from 'node:path';
import { TextDecoder } from 'node:util';

import {
  PROTECTED_DATA_CLOCK_SKEW_MS,
  PROTECTED_DATA_GCM_TAG_BYTES,
  PROTECTED_DATA_MAX_BODY_BYTES,
  PROTECTED_DATA_MAX_RSA_BITS,
  PROTECTED_DATA_MAX_VALUE_BYTES,
  PROTECTED_DATA_MIN_RSA_BITS,
  PROTECTED_DATA_TTL_MS,
  isProtectedDataAlias,
  isProtectedDataLabel,
  protectedDataAad,
  readProtectedDataEnvelope,
  type ProtectedDataEnvelope,
  type ProtectedDataProfile,
  type ProtectedDataStatus,
} from './protocol.js';

// GOLDJAXE fork (реестр §27, §27.1): проверка доставки без сети или один настроенный HTTPS GET.
const CHECK_TIMEOUT_MS = 5_000;
const MAX_PENDING_CHECKS = 16;
const MAX_NONCES = 4096;
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const CONTROLS = /[\u0000-\u001f\u007f]/u;
const CONFIG_FIELDS = ['socketPath', 'privateKeyPath', 'label', 'target', 'auth', 'urlField', 'operation'];

type Auth = { type: 'bearer'; tokenField: string } | { type: 'basic'; loginField: string; passwordField: string };
type ExecutorConfig = {
  label: string;
  socketPath: string;
  privateKeyPath: string;
} & (
  | { operation: 'local-check' }
  | { operation: 'https-check'; target: string; auth: Auth; urlField?: string }
);
type Check = (target: string, authorization: string, signal: AbortSignal) => Promise<number | undefined>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLocalPath(value: unknown, limit = 4095): value is string {
  return typeof value === 'string' && value.length <= limit && Buffer.byteLength(value, 'utf8') <= limit
    && isAbsolute(value) && !CONTROLS.test(value);
}

function isHttpsTarget(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > PROTECTED_DATA_MAX_VALUE_BYTES
    || Buffer.byteLength(value, 'utf8') > PROTECTED_DATA_MAX_VALUE_BYTES
    || !/^https:\/\/[^/?#@]+(?:[/?]|$)/i.test(value) || /[\s\\#]/u.test(value) || CONTROLS.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

function readPrivateFile(path: string, uid: number): Buffer {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    // И ключ, и целевой URL недоступны через общий с CloudCLI доступ к сокету.
    if (!stat.isFile() || stat.size > 16 * 1024 || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
      throw new Error('Недопустимый локальный файл');
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readAuth(value: unknown): Auth | null {
  if (!isRecord(value)) return null;
  const { type, tokenField, loginField, passwordField } = value;
  const size = Object.keys(value).length;
  if (type === 'bearer' && size === 2 && isProtectedDataAlias(tokenField)) return { type, tokenField };
  if (type === 'basic' && size === 3 && isProtectedDataAlias(loginField)
    && isProtectedDataAlias(passwordField) && loginField !== passwordField) return { type, loginField, passwordField };
  return null;
}

function authFields(auth: Auth): string[] {
  return auth.type === 'bearer' ? [auth.tokenField] : [auth.loginField, auth.passwordField];
}

function readConfig(path: string, uid: number): ExecutorConfig {
  const config = readPrivateFile(path, uid);
  let value: unknown;
  try {
    value = JSON.parse(UTF8.decode(config));
  } finally {
    config.fill(0);
  }
  if (!isRecord(value) || Object.keys(value).some((key) => !CONFIG_FIELDS.includes(key))) {
    throw new Error('Недопустимая конфигурация исполнителя');
  }
  const { socketPath, privateKeyPath, label, target, urlField, operation } = value;
  // Linux sun_path: 108 байт вместе с завершающим NUL.
  if (!isLocalPath(socketPath, 107) || !isLocalPath(privateKeyPath) || !isProtectedDataLabel(label)) {
    throw new Error('Недопустимая конфигурация исполнителя');
  }
  if (operation === 'local-check' && !('target' in value || 'auth' in value || 'urlField' in value)) {
    return { socketPath, privateKeyPath, label, operation };
  }
  const auth = readAuth(value.auth);
  if (operation !== undefined || !isHttpsTarget(target) || !auth
    || (urlField !== undefined && (!isProtectedDataAlias(urlField) || authFields(auth).includes(urlField)))) {
    throw new Error('Недопустимая конфигурация исполнителя');
  }
  return { socketPath, privateKeyPath, label, operation: 'https-check', target, auth, urlField };
}

function readPrivateKey(path: string, uid: number): { key: KeyObject; wrappedKeyBytes: number } {
  // При установке используется отдельный UID; общий с CloudCLI только доступ к сокету.
  const pem = readPrivateFile(path, uid);
  try {
    const key = createPrivateKey(pem);
    const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
    if (key.asymmetricKeyType !== 'rsa' || bits < PROTECTED_DATA_MIN_RSA_BITS || bits > PROTECTED_DATA_MAX_RSA_BITS) {
      throw new Error('Недопустимый ключ исполнителя');
    }
    return { key, wrappedKeyBytes: Math.ceil(bits / 8) };
  } finally {
    pem.fill(0);
  }
}

function openEnvelope(
  key: KeyObject, wrappedKeyBytes: number, envelope: ProtectedDataEnvelope, selectedFields: ReadonlySet<string>,
): Map<string, string> | null {
  const wrappedKey = Buffer.from(envelope.wrappedKey, 'base64');
  if (wrappedKey.length !== wrappedKeyBytes) return null;
  const aesKey = privateDecrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, wrappedKey);
  try {
    if (aesKey.length !== 32) return null;
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    const tagOffset = ciphertext.length - PROTECTED_DATA_GCM_TAG_BYTES;
    const decipher = createDecipheriv('aes-256-gcm', aesKey, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(protectedDataAad(envelope));
    decipher.setAuthTag(ciphertext.subarray(tagOffset));
    const plaintext = decipher.update(ciphertext.subarray(0, tagOffset));
    try {
      decipher.final(); // Проверить тег до чтения незаверенных данных.
      const values: unknown = JSON.parse(UTF8.decode(plaintext));
      if (!Array.isArray(values) || values.length !== envelope.names.length) return null;
      const fields = new Map<string, string>();
      for (let index = 0; index < values.length; index += 1) {
        const value: unknown = values[index];
        if (typeof value !== 'string' || value.length === 0 || value.length > PROTECTED_DATA_MAX_VALUE_BYTES
          || Buffer.byteLength(value, 'utf8') > PROTECTED_DATA_MAX_VALUE_BYTES || /[\uD800-\uDFFF]/u.test(value)) return null;
        const name = envelope.names[index];
        if (selectedFields.has(name)) fields.set(name, value);
      }
      return fields;
    } finally {
      plaintext.fill(0);
    }
  } finally {
    aesKey.fill(0);
  }
}

function authorizationHeader(auth: Auth, fields: Map<string, string>): string | null {
  if (auth.type === 'bearer') {
    const token = fields.get(auth.tokenField);
    return token && /^[A-Za-z0-9._~+/-]+=*$/.test(token) ? `Bearer ${token}` : null;
  }
  const login = fields.get(auth.loginField);
  const password = fields.get(auth.passwordField);
  if (login === undefined || password === undefined || login.includes(':') || CONTROLS.test(login) || CONTROLS.test(password)) return null;
  return `Basic ${Buffer.from(`${login}:${password}`, 'utf8').toString('base64')}`;
}

const checkHttps: Check = (target, authorization, signal) => new Promise((resolve) => {
  // Новый агент без настроек прокси; никаких редиректов и чтения тела ответа.
  const req = httpsRequest(target, { method: 'GET', agent: false, rejectUnauthorized: true, signal }, (res) => {
    resolve(res.statusCode);
    res.destroy();
  });
  req.on('error', () => resolve(undefined));
  req.once('close', () => resolve(undefined));
  req.setHeader('Authorization', authorization);
  req.end();
});

function statusFor(code: number | undefined): ProtectedDataStatus {
  if (code === 401 || code === 403) return 'denied';
  return code !== undefined && Number.isInteger(code) && code >= 200 && code < 300 ? 'ok' : 'failed';
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const limit = Number(req.headers['content-length'] ?? (req.headers['transfer-encoding'] ? PROTECTED_DATA_MAX_BODY_BYTES : 0));
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PROTECTED_DATA_MAX_BODY_BYTES) return null;
  const buffer = Buffer.alloc(limit);
  let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    if (!Buffer.isBuffer(chunk) || length + chunk.length > limit) return null;
    length += chunk.copy(buffer, length);
  }
  return JSON.parse(UTF8.decode(buffer.subarray(0, length))) as unknown;
}

function sendJson(res: ServerResponse, body: ProtectedDataProfile | { status: ProtectedDataStatus }, code = 200): void {
  if (res.destroyed || res.writableEnded) return;
  const json = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json, 'utf8'),
    'cache-control': 'no-store',
    connection: 'close',
  });
  res.end(json);
}

export async function startProtectedDataExecutor(
  configPath: string | undefined,
  { check = checkHttps, now = Date.now }: { check?: Check; now?: () => number } = {},
): Promise<{ close(): Promise<void> }> {
  const uid = process.geteuid?.();
  if (process.platform !== 'linux' || uid === undefined || !isLocalPath(configPath)) {
    throw new Error('Исполнитель не настроен');
  }
  const config = readConfig(configPath, uid);
  const directory = statSync(dirname(config.socketPath));
  if (!directory.isDirectory() || (directory.uid !== uid && directory.uid !== 0) || (directory.mode & 0o022) !== 0) {
    throw new Error('Недопустимый каталог сокета исполнителя');
  }
  const { key, wrappedKeyBytes } = readPrivateKey(config.privateKeyPath, uid);
  const localOnly = config.operation === 'local-check';
  const requiredFields = localOnly ? [] : authFields(config.auth);
  const selectedFields = new Set(requiredFields);
  const urlField = localOnly ? undefined : config.urlField;
  if (urlField !== undefined) selectedFields.add(urlField);
  const profile: ProtectedDataProfile = {
    revision: randomBytes(32).toString('hex'),
    publicKey: createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64'),
    label: config.label,
    requiredFields,
    ...(localOnly ? { operation: 'local-check' } : {}),
    ...(urlField === undefined ? {} : { urlField }),
  };
  const nonces = new Map<string, number>();
  const shutdown = new AbortController();
  let pending = 0;
  let lastNow = 0;

  async function execute(value: unknown): Promise<ProtectedDataStatus> {
    const envelope = readProtectedDataEnvelope(value);
    if (!envelope || envelope.revision !== profile.revision) return 'invalid';
    // Перевод часов назад не должен возвращать к жизни просроченные конверты.
    const time = lastNow = Math.max(lastNow, now());
    const age = time - envelope.issuedAt;
    if (age >= PROTECTED_DATA_TTL_MS) return 'expired';
    if (age < -PROTECTED_DATA_CLOCK_SKEW_MS || !requiredFields.every((name) => envelope.names.includes(name))) return 'invalid';

    let remote: { target: string; authorization: string } | undefined;
    try {
      const fields = openEnvelope(key, wrappedKeyBytes, envelope, selectedFields);
      if (!fields) return 'invalid';
      if (config.operation === 'https-check') {
        if (urlField !== undefined && fields.has(urlField) && fields.get(urlField) !== config.target) return 'invalid';
        const authorization = authorizationHeader(config.auth, fields);
        if (!authorization) return 'invalid';
        remote = { target: config.target, authorization };
      }
    } catch {
      return 'invalid';
    }

    const nonce = envelope.nonce.toLowerCase();
    if ((nonces.get(nonce) ?? 0) > time) return 'used';
    if (nonces.size >= MAX_NONCES) {
      for (const [value, until] of nonces) if (until <= time) nonces.delete(value);
      if (nonces.size >= MAX_NONCES) return 'failed';
    }
    // Резервируем до первого await; ошибка или обрыв не разрешают повтор.
    nonces.set(nonce, envelope.issuedAt + PROTECTED_DATA_TTL_MS);
    if (shutdown.signal.aborted) return 'failed';
    // GOLDJAXE fork (реестр §27.1): в локальном режиме значения не используются вне проверки конверта.
    if (!remote) return 'received';
    if (pending >= MAX_PENDING_CHECKS) return 'failed';
    pending += 1;
    try {
      const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(CHECK_TIMEOUT_MS)]);
      const code = await check(remote.target, remote.authorization, signal);
      return signal.aborted ? 'failed' : statusFor(code);
    } catch {
      return 'failed';
    } finally {
      pending -= 1;
    }
  }

  const server = createServer({
    maxHeaderSize: 8 * 1024,
    requestTimeout: 5_000,
    headersTimeout: 5_000,
    connectionsCheckingInterval: 1_000,
  }, (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/profile') return sendJson(res, profile);
    if (req.method !== 'POST' || req.url !== '/v1/execute') return sendJson(res, { status: 'invalid' }, 404);
    void readBody(req).then(execute).catch(() => 'invalid' as const)
      .then((status) => sendJson(res, { status })).catch(() => res.destroy());
  });
  server.maxConnections = 32;
  server.maxRequestsPerSocket = 1;
  server.setTimeout(10_000);
  server.on('clientError', (_error, socket) => socket.destroy());

  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    if (!closing) {
      shutdown.abort();
      closing = new Promise((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
    }
    return closing;
  }

  const listening = once(server, 'listening');
  // На этапе bind сокет должен быть доступен на запись только владельцу.
  const mask = process.umask(0o177);
  try {
    server.listen(config.socketPath);
  } finally {
    process.umask(mask);
  }
  await listening;
  try {
    chmodSync(config.socketPath, 0o660);
  } catch (error) {
    await close();
    throw error;
  }
  server.on('error', () => void close());
  return { close };
}
