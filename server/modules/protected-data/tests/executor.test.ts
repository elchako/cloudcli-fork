import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { generateKeyPairSync, randomUUID, webcrypto } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { startProtectedDataExecutor } from '../executor.js';
import {
  PROTECTED_DATA_CLOCK_SKEW_MS,
  PROTECTED_DATA_MAX_BODY_BYTES,
  PROTECTED_DATA_MAX_VALUE_BYTES,
  PROTECTED_DATA_TTL_MS,
  readProtectedDataEnvelope,
  readProtectedDataProfile,
  readProtectedDataStatus,
  type ProtectedDataEnvelope,
  type ProtectedDataProfile,
} from '../protocol.js';

const TARGET = 'https://protected.invalid:8443/check?mode=readonly';
const NOW = 1_800_000_000_000;
const TOKEN = 'test-token';
const KEY = generateKeyPairSync('rsa', { modulusLength: 2048 });

function http(socketPath: string, method: string, path: string, body?: string, length = Buffer.byteLength(body ?? '')) {
  return new Promise<{ code: number | undefined; headers: IncomingHttpHeaders; body: unknown }>((resolve, reject) => {
    const req = request({
      socketPath, method, path, agent: false, signal: AbortSignal.timeout(8_000),
      headers: method === 'POST' ? { 'content-type': 'application/json', 'content-length': length } : undefined,
    }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (part: Buffer) => parts.push(part));
      res.on('error', reject);
      res.on('end', () => {
        try {
          resolve({ code: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function fixture(t: TestContext, overrides: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'pd-executor-'));
  const socketPath = join(directory, 'executor.sock');
  const configPath = join(directory, 'executor.json');
  const privateKeyPath = join(directory, 'test-key.pem');
  let executor: Awaited<ReturnType<typeof startProtectedDataExecutor>> | undefined;
  t.after(async () => {
    await executor?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const writeConfig = (patch: Record<string, unknown> = {}) => writeFileSync(configPath, JSON.stringify({
    socketPath, privateKeyPath, label: 'Тестовая проверка', target: TARGET,
    auth: { type: 'bearer', tokenField: 'TOKEN' }, urlField: 'URL', ...overrides, ...patch,
  }), { mode: 0o600 });
  writeConfig();
  writeFileSync(privateKeyPath, KEY.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  return {
    socketPath, configPath, privateKeyPath, writeConfig,
    async start(options: Parameters<typeof startProtectedDataExecutor>[1]) {
      executor = await startProtectedDataExecutor(configPath, { now: () => NOW, ...options });
      return executor;
    },
    async profile() {
      const result = await http(socketPath, 'GET', '/v1/profile');
      assert.equal(result.code, 200);
      const profile = readProtectedDataProfile(result.body);
      assert.ok(profile);
      assert.deepEqual(result.body, profile);
      assert.equal(JSON.stringify(result.body).includes(TARGET), false);
      assert.equal(Object.hasOwn(profile, 'target'), false);
      return profile;
    },
    async execute(value: unknown) {
      const result = await http(socketPath, 'POST', '/v1/execute', JSON.stringify(value));
      assert.equal(result.code, 200);
      assert.equal(result.headers['cache-control'], 'no-store');
      const status = result.body !== null && typeof result.body === 'object' && 'status' in result.body
        ? readProtectedDataStatus(result.body.status) : null;
      assert.ok(status);
      assert.deepEqual(result.body, { status });
      assert.equal(JSON.stringify(result).includes(TARGET), false);
      return status;
    },
  };
}

// Web Crypto и независимая сериализация AAD повторяют браузерную сторону wire-контракта.
async function seal(
  profile: ProtectedDataProfile, { names = ['TOKEN'], values = [TOKEN], issuedAt = NOW }: {
    names?: string[]; values?: unknown; issuedAt?: number;
  } = {},
): Promise<ProtectedDataEnvelope> {
  const { subtle } = webcrypto;
  const { revision } = profile;
  const sessionId = 'session-1';
  const nonce = randomUUID();
  const publicKey = await subtle.importKey('spki', Buffer.from(profile.publicKey, 'base64'),
    { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const contentKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const wrappedKey = await subtle.encrypt('RSA-OAEP', publicKey, await subtle.exportKey('raw', contentKey));
  const ciphertext = await subtle.encrypt({
    name: 'AES-GCM', iv, tagLength: 128,
    additionalData: Buffer.from(JSON.stringify([1, revision, sessionId, nonce, issuedAt, names]), 'utf8'),
  }, contentKey, Buffer.from(JSON.stringify(values), 'utf8'));
  return {
    version: 1, revision, sessionId, nonce, issuedAt, names,
    wrappedKey: Buffer.from(wrappedKey).toString('base64'),
    iv: Buffer.from(iv).toString('base64'),
    ciphertext: Buffer.from(ciphertext).toString('base64'),
  };
}

test('локальная проверка подтверждает только доставку и не вызывает сетевой обработчик', async (t) => {
  const fx = fixture(t, { operation: 'local-check', target: undefined, auth: undefined, urlField: undefined });
  let calls = 0;
  await fx.start({ check: async () => { calls++; return 200; } });
  const profile = await fx.profile();
  assert.equal(profile.operation, 'local-check');
  assert.deepEqual(profile.requiredFields, []);
  const sealed = await seal(profile, { names: ['FIRST', 'SECOND'], values: ['sample-a', 'sample-b'] });
  assert.equal(await fx.execute(sealed), 'received');
  assert.equal(await fx.execute(sealed), 'used');
  assert.equal(await fx.execute(await seal(profile, { values: [''] })), 'invalid');
  assert.equal(calls, 0);
});

test('локальный исполнитель отказывается запускаться с сетевым назначением', async (t) => {
  const fx = fixture(t, { operation: 'local-check' });
  await assert.rejects(fx.start({}), /Недопустимая конфигурация/);
  assert.equal(existsSync(fx.socketPath), false);
});

test('профиль и режим сокета; nonce резервируется до окончания HTTPS-проверки', async (t) => {
  const fx = fixture(t);
  const calls: [string, string][] = [];
  let release = () => {};
  let enter = () => {};
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  await fx.start({ check: async (target, authorization) => {
    calls.push([target, authorization]);
    if (calls.length === 1) { enter(); await pending; }
    return 204;
  } });
  const socket = lstatSync(fx.socketPath);
  assert.ok(socket.isSocket());
  assert.equal(socket.mode & 0o777, 0o660);
  const profile = await fx.profile();
  assert.match(profile.revision, /^[a-f0-9]{64}$/);
  assert.equal(profile.publicKey, KEY.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
  assert.equal(profile.label, 'Тестовая проверка');
  assert.deepEqual(profile.requiredFields, ['TOKEN']);
  assert.equal(profile.urlField, 'URL');
  const envelope = await seal(profile, { names: ['URL', 'TOKEN'], values: [TARGET, TOKEN] });
  const first = fx.execute(envelope);
  await entered;
  try {
    assert.equal(await fx.execute(envelope), 'used');
  } finally {
    release();
  }
  assert.equal(await first, 'ok');
  assert.equal(await fx.execute(envelope), 'used');
  assert.deepEqual(calls, [[TARGET, `Bearer ${TOKEN}`]]);
});

test('URL не меняет цель; дубликаты и отсутствие обязательного поля отклоняются', async (t) => {
  const fx = fixture(t);
  let calls = 0;
  await fx.start({ check: async () => { calls += 1; return 200; } });
  const profile = await fx.profile();
  const cases: [string[], unknown][] = [
    [['TOKEN', 'URL'], [TOKEN, 'https://other.invalid/check']],
    [['TOKEN', 'URL'], [TOKEN, `${TARGET} `]],
    [['TOKEN', 'URL'], [TOKEN, '']],
    [['URL'], [TARGET]],
    [['TOKEN', 'TOKEN'], [TOKEN, TOKEN]],
    [['TOKEN'], [TOKEN, 'test']],
    [['TOKEN'], [1]],
    [['TOKEN'], ['bad\r\nInjected: value']],
  ];
  for (const [names, values] of cases) {
    assert.equal(await fx.execute(await seal(profile, { names, values })), 'invalid');
  }
  assert.equal(calls, 0);
  assert.equal(await fx.execute(await seal(profile)), 'ok'); // Поле URL необязательно.
  assert.equal(calls, 1);
});

test('Bearer принимает дополнительные поля, не отправляя их в HTTPS-запрос', async (t) => {
  const fx = fixture(t);
  const calls: [string, string][] = [];
  await fx.start({ check: async (target, authorization) => { calls.push([target, authorization]); return 200; } });
  const profile = await fx.profile();
  const names = ['URL', 'LOGIN', 'PASSWORD', 'TOKEN'];
  assert.equal(await fx.execute(await seal(profile, { names, values: [TARGET, 'extra-login', 'extra-password', TOKEN] })), 'ok');
  assert.equal(await fx.execute(await seal(profile, { names, values: [TARGET, 'extra-login', 123, TOKEN] })), 'invalid');
  assert.deepEqual(calls, [[TARGET, `Bearer ${TOKEN}`]]);
});

test('подмена AAD, IV, обёрнутого ключа и тега не расходует исходный nonce', async (t) => {
  const fx = fixture(t);
  let calls = 0;
  await fx.start({ check: async () => { calls += 1; return 200; } });
  const envelope = await seal(await fx.profile(), { names: ['TOKEN', 'URL'], values: [TOKEN, TARGET] });
  const flipLastByte = (encoded: string) => {
    const bytes = Buffer.from(encoded, 'base64');
    bytes[bytes.length - 1] ^= 1;
    return bytes.toString('base64');
  };
  for (const patch of [
    { sessionId: 'session-2' }, { nonce: randomUUID() }, { issuedAt: NOW + 1 }, { names: ['URL', 'TOKEN'] },
    { wrappedKey: flipLastByte(envelope.wrappedKey) }, { iv: flipLastByte(envelope.iv) },
    { ciphertext: flipLastByte(envelope.ciphertext) }, { target: TARGET },
  ]) {
    assert.equal(await fx.execute({ ...envelope, ...patch }), 'invalid');
  }
  assert.equal(calls, 0);
  assert.equal(await fx.execute(envelope), 'ok');
});

test('TTL, допуск часов, защита от отката времени и смена ревизии при перезапуске', async (t) => {
  const fx = fixture(t);
  let clock = NOW;
  let calls = 0;
  const options = { now: () => clock, check: async () => { calls += 1; return 200; } };
  const executor = await fx.start(options);
  const profile = await fx.profile();
  const envelope = await seal(profile);
  assert.equal(await fx.execute(await seal(profile, { issuedAt: NOW - PROTECTED_DATA_TTL_MS })), 'expired');
  assert.equal(await fx.execute(await seal(profile, { issuedAt: NOW + PROTECTED_DATA_CLOCK_SKEW_MS + 1 })), 'invalid');
  assert.equal(await fx.execute(await seal(profile, { issuedAt: NOW + PROTECTED_DATA_CLOCK_SKEW_MS })), 'ok');
  assert.equal(await fx.execute(envelope), 'ok');
  clock += PROTECTED_DATA_TTL_MS;
  assert.equal(await fx.execute(envelope), 'expired');
  clock = NOW;
  assert.equal(await fx.execute(envelope), 'expired');
  await executor.close();
  assert.equal(existsSync(fx.socketPath), false);
  await fx.start(options);
  const restarted = await fx.profile();
  assert.notEqual(restarted.revision, profile.revision);
  assert.equal(restarted.publicKey, profile.publicKey);
  assert.equal(await fx.execute(envelope), 'invalid');
  assert.equal(calls, 2);
});

test('Basic использует порядок aliases и лимит байтов UTF-8, а не число символов', async (t) => {
  const fx = fixture(t, { auth: { type: 'basic', loginField: 'LOGIN', passwordField: 'PASSWORD' }, urlField: undefined });
  const password = 'я'.repeat(PROTECTED_DATA_MAX_VALUE_BYTES / 2);
  const calls: string[] = [];
  await fx.start({ check: async (_target, authorization) => { calls.push(authorization); return 200; } });
  const profile = await fx.profile();
  assert.deepEqual(profile.requiredFields, ['LOGIN', 'PASSWORD']);
  assert.equal(Object.hasOwn(profile, 'urlField'), false);
  const names = ['PASSWORD', 'LOGIN'];
  assert.equal(await fx.execute(await seal(profile, { names, values: [password, 'test'] })), 'ok');
  assert.equal(await fx.execute(await seal(profile, { names, values: [`${password}я`, 'test'] })), 'invalid');
  assert.equal(await fx.execute(await seal(profile, { names, values: ['test', 'ambiguous:login'] })), 'invalid');
  assert.deepEqual(calls, [`Basic ${Buffer.from(`test:${password}`).toString('base64')}`]);
});

test('ответ проверки сводится к фиксированным статусам и не выдаёт исключения', async (t) => {
  const fx = fixture(t);
  let code: number | undefined = 200;
  await fx.start({ check: async () => {
    if (code === undefined) throw new Error('test remote details');
    return code;
  } });
  const profile = await fx.profile();
  for (const [value, status] of [[200, 'ok'], [299, 'ok'], [401, 'denied'], [403, 'denied'],
    [302, 'failed'], [500, 'failed'], [undefined, 'failed']] as const) {
    code = value;
    const envelope = await seal(profile);
    assert.equal(await fx.execute(envelope), status);
    assert.equal(await fx.execute(envelope), 'used');
  }
  const result = await http(fx.socketPath, 'POST', '/v1/execute', undefined, PROTECTED_DATA_MAX_BODY_BYTES + 1);
  assert.equal(result.code, 200);
  assert.deepEqual(result.body, { status: 'invalid' });
  assert.equal((await http(fx.socketPath, 'GET', '/v1/profile?extra=1')).code, 404);
});

test('остановка отменяет активную проверку и освобождает путь сокета', async (t) => {
  const fx = fixture(t);
  let enter!: (signal: AbortSignal) => void;
  const entered = new Promise<AbortSignal>((resolve) => { enter = resolve; });
  const executor = await fx.start({ check: (_target, _authorization, signal) => new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(undefined), { once: true });
    enter(signal);
  }) });
  const attempt = fx.execute(await seal(await fx.profile())).catch(() => null);
  const signal = await entered;
  assert.equal(signal.aborted, false);
  await Promise.all([executor.close(), executor.close()]);
  assert.equal(signal.aborted, true);
  assert.equal(existsSync(fx.socketPath), false);
  const result = await attempt;
  assert.ok(result === null || result === 'failed');
});

test('wire-парсеры отклоняют некорректные типы и кодировки', async (t) => {
  const fx = fixture(t);
  await fx.start({ check: async () => assert.fail('Не должно быть проверки') });
  const profile = await fx.profile();
  const envelope = await seal(profile);
  assert.deepEqual(readProtectedDataEnvelope(envelope), envelope);
  for (const item of [null, [], { ...envelope, version: 2 }, { ...envelope, issuedAt: 1.25 },
    { ...envelope, nonce: '00000000-0000-0000-0000-000000000000' }, { ...envelope, sessionId: '../session' },
    { ...envelope, names: ['TOKEN\n'] }, { ...envelope, names: Array.from({ length: 13 }, (_, i) => `N${i}`) },
    { ...envelope, iv: 'AA==' }, { ...envelope, wrappedKey: `${envelope.wrappedKey}\n` }]) {
    assert.equal(readProtectedDataEnvelope(item), null);
  }
  const derWithTrailer = Buffer.concat([Buffer.from(profile.publicKey, 'base64'), Buffer.from([0])]);
  assert.equal(readProtectedDataProfile({ ...profile, publicKey: derWithTrailer.toString('base64') }), null);
  assert.equal(readProtectedDataProfile({ ...profile, urlField: 'TOKEN' }), null);
  assert.equal(readProtectedDataProfile({ ...profile, target: TARGET }), null);
  assert.equal(readProtectedDataStatus('success'), null);
});

test('запуск без доверенного конфига, закрытого RSA-ключа или свободного сокета запрещён', async (t) => {
  const fx = fixture(t);
  const options = { check: async () => assert.fail('Не должно быть проверки') };
  await assert.rejects(startProtectedDataExecutor(undefined, options));
  for (const patch of [{ target: 'http://protected.invalid' }, { target: 'https://user@protected.invalid/' },
    { target: `${TARGET}#fragment` }, { urlField: 'TOKEN' }]) {
    fx.writeConfig(patch);
    await assert.rejects(fx.start(options));
    assert.equal(existsSync(fx.socketPath), false);
  }
  fx.writeConfig();
  chmodSync(fx.configPath, 0o622);
  await assert.rejects(fx.start(options));
  chmodSync(fx.configPath, 0o600);
  chmodSync(fx.privateKeyPath, 0o640);
  await assert.rejects(fx.start(options));
  chmodSync(fx.privateKeyPath, 0o600);
  const weak = generateKeyPairSync('rsa', { modulusLength: 1024 });
  writeFileSync(fx.privateKeyPath, weak.privateKey.export({ format: 'pem', type: 'pkcs8' }));
  await assert.rejects(fx.start(options));
  assert.equal(existsSync(fx.socketPath), false);
  writeFileSync(fx.privateKeyPath, KEY.privateKey.export({ format: 'pem', type: 'pkcs8' }));
  writeFileSync(fx.socketPath, 'existing file');
  await assert.rejects(fx.start(options));
  assert.equal(readFileSync(fx.socketPath, 'utf8'), 'existing file');
});
