import { webcrypto } from 'node:crypto';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadProtectedDataProfile,
  stageProtectedData,
  validateProtectedFields,
  type ProtectedDataProfile,
  type ProtectedField,
} from '@/modules/chat/protected-data/protected-data-client';

type Envelope = {
  version: number;
  revision: string;
  sessionId: string;
  nonce: string;
  issuedAt: number;
  names: string[];
  wrappedKey: string;
  iv: string;
  ciphertext: string;
};

const sessionId = 'test-session';
const syntheticUrl = 'https://example.invalid/synthetic-private-path';
const fields = [
  { name: 'URL', value: syntheticUrl },
  { name: 'TOKEN', value: 'synthetic "ключ" \\ café' },
  { name: 'token', value: '  ' },
];
const fetchMock = vi.fn<typeof fetch>();
let profile: ProtectedDataProfile;
let rsaPrivateKey: CryptoKey;

beforeAll(async () => {
  const pair = await webcrypto.subtle.generateKey({
    name: 'RSA-OAEP', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]),
  }, true, ['wrapKey', 'unwrapKey']);
  rsaPrivateKey = pair.privateKey;
  profile = {
    revision: 'c'.repeat(64),
    publicKey: Buffer.from(await webcrypto.subtle.exportKey('spki', pair.publicKey)).toString('base64'),
    label: 'Test connection',
    requiredFields: ['TOKEN'],
    urlField: 'URL',
  };
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => vi.unstubAllGlobals());

function decode(value: string) {
  const bytes = Buffer.from(value, 'base64');
  expect(bytes.toString('base64')).toBe(value);
  return bytes;
}

async function unwrapKey(envelope: Envelope) {
  return webcrypto.subtle.unwrapKey('raw', decode(envelope.wrappedKey), rsaPrivateKey, 'RSA-OAEP', 'AES-GCM', true, ['decrypt']);
}

function decrypt(envelope: Envelope, key: CryptoKey) {
  const additionalData = new TextEncoder().encode(JSON.stringify([
    1, envelope.revision, envelope.sessionId, envelope.nonce, envelope.issuedAt, envelope.names,
  ]));
  return webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(envelope.iv), additionalData, tagLength: 128 }, key, decode(envelope.ciphertext));
}

describe('публичный профиль §27', () => {
  it('читает только поля контракта, прокидывает signal и отключает кэш', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ...profile, target: syntheticUrl }));
    const { signal } = new AbortController();
    expect(await loadProtectedDataProfile(signal)).toEqual(profile);
    expect(fetchMock).toHaveBeenCalledWith('/api/protected-data', expect.objectContaining({ method: 'GET', cache: 'no-store', redirect: 'error', signal }));
  });

  it('возвращает null на 503 и не раскрывает ответ при другой ошибке', async () => {
    fetchMock.mockResolvedValueOnce(new Response(syntheticUrl, { status: 503 }));
    await expect(loadProtectedDataProfile()).resolves.toBeNull();
    fetchMock.mockResolvedValueOnce(new Response(syntheticUrl, { status: 500 }));
    await expect(loadProtectedDataProfile()).rejects.toMatchObject({ code: 'profileUnavailable', message: 'profileUnavailable' });
  });

  it('отклоняет повреждённый профиль и не передаёт причину отмены', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ...profile, revision: syntheticUrl }));
    await expect(loadProtectedDataProfile()).rejects.toMatchObject({ code: 'invalidProfile', message: 'invalidProfile' });
    const controller = new AbortController();
    controller.abort(new Error(syntheticUrl));
    fetchMock.mockRejectedValueOnce(controller.signal.reason);
    await expect(loadProtectedDataProfile(controller.signal)).rejects.toMatchObject({ name: 'AbortError', message: 'Запрос отменён' });
  });
});

describe('валидация полей §27', () => {
  it('сравнивает алиасы точно, проверяет уникальность, синтаксис и обязательные поля', () => {
    expect(validateProtectedFields(profile, fields)).toBeNull();
    expect(validateProtectedFields(profile, [{ name: 'token', value: 'x' }])).toEqual({ code: 'missingRequired' });
    expect(validateProtectedFields(profile, [...fields, { name: 'TOKEN', value: 'x' }])).toEqual({ code: 'duplicateName', row: 3, field: 'name' });
    for (const name of ['1TOKEN', 'Токен', 'TOKEN ', 'TOKEN\n', `A${'A'.repeat(32)}`]) {
      expect(validateProtectedFields(profile, [{ name, value: 'x' }])).toEqual({ code: 'invalidName', row: 0, field: 'name' });
    }
    expect(validateProtectedFields(profile, [])).toEqual({ code: 'invalidCount' });
    expect(validateProtectedFields(profile, Array.from({ length: 13 }, (_, i) => ({ name: `F${i}`, value: 'x' })))).toEqual({ code: 'invalidCount' });
  });

  it('проверяет 4096 байт UTF-8 на значение и 60 КиБ уже после JSON-экранирования', () => {
    const token = (value: string): ProtectedField => ({ name: 'TOKEN', value });
    const codepoint = String.fromCodePoint(0x1f680);
    expect(validateProtectedFields(profile, [token('')])).toEqual({ code: 'emptyValue', row: 0, field: 'value' });
    expect(validateProtectedFields(profile, [token(codepoint.repeat(1024))])).toBeNull();
    expect(validateProtectedFields(profile, [token(codepoint.repeat(1024) + 'x')])).toEqual({ code: 'valueTooLarge', row: 0, field: 'value' });
    const first = token('\0'.repeat(4096));
    const second = { name: 'B', value: '\0'.repeat(4096) };
    const third = { name: 'C', value: '\0'.repeat(2046) + 'xx' };
    expect(validateProtectedFields(profile, [first, second, third])).toBeNull();
    expect(validateProtectedFields(profile, [first, second, { ...third, value: third.value + 'x' }])).toEqual({ code: 'tooLarge' });
  });
});

describe('шифрование и staging §27', () => {
  it('отправляет только конверт, а независимая расшифровка проверяет порядок значений и AAD', async () => {
    fetchMock.mockImplementation(async () => Response.json({ id: 'test-grant' }, { status: 201 }));
    const started = Date.now();
    await expect(stageProtectedData(profile, sessionId, fields)).resolves.toBe('test-grant');
    await expect(stageProtectedData(profile, sessionId, fields)).resolves.toBe('test-grant');
    const [first, second] = fetchMock.mock.calls.map(([url, init]) => {
      expect(url).toBe('/api/protected-data');
      expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
      const body = init?.body as string;
      expect(body).not.toContain(syntheticUrl);
      expect(body).not.toContain('synthetic');
      expect(body).not.toContain(profile.publicKey);
      const envelope = JSON.parse(body) as Envelope;
      expect(Object.keys(envelope).sort()).toEqual(['ciphertext', 'issuedAt', 'iv', 'names', 'nonce', 'revision', 'sessionId', 'version', 'wrappedKey']);
      expect(envelope).toMatchObject({ version: 1, revision: profile.revision, sessionId, names: ['URL', 'TOKEN', 'token'] });
      expect(envelope.nonce).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      expect(envelope.issuedAt).toBeGreaterThanOrEqual(started);
      expect(envelope.issuedAt).toBeLessThanOrEqual(Date.now());
      expect(decode(envelope.iv)).toHaveLength(12);
      return envelope;
    });
    expect(second.nonce).not.toBe(first.nonce);
    expect(second.iv).not.toBe(first.iv);
    const [key1, key2] = await Promise.all([unwrapKey(first), unwrapKey(second)]);
    const rawKey1 = Buffer.from(await webcrypto.subtle.exportKey('raw', key1));
    expect(rawKey1).toHaveLength(32);
    expect(rawKey1).not.toEqual(Buffer.from(await webcrypto.subtle.exportKey('raw', key2)));
    const plaintext = Buffer.from(await decrypt(first, key1)).toString('utf8');
    expect(JSON.parse(plaintext)).toEqual(fields.map(({ value }) => value));
    expect(decode(first.ciphertext)).toHaveLength(Buffer.byteLength(plaintext) + 16);
    await expect(decrypt({ ...first, sessionId: 'another-session' }, key1)).rejects.toThrow();
    await expect(decrypt({ ...first, names: [...first.names].reverse() }, key1)).rejects.toThrow();
  });

  it('не делает HTTP-запрос в небезопасном контексте, с неверным вводом или при сбое шифрования', async () => {
    vi.stubGlobal('isSecureContext', false);
    await expect(stageProtectedData(profile, sessionId, fields)).rejects.toMatchObject({ code: 'insecureContext' });
    vi.stubGlobal('isSecureContext', true);
    await expect(stageProtectedData(profile, 'bad session', fields)).rejects.toMatchObject({ code: 'invalidSession' });
    await expect(stageProtectedData(profile, sessionId, [{ name: 'bad name', value: syntheticUrl }])).rejects.toMatchObject({ code: 'invalidName', message: 'invalidName' });
    await expect(stageProtectedData({ ...profile, publicKey: 'AAAA' }, sessionId, fields)).rejects.toMatchObject({ code: 'encryptionFailed', message: 'encryptionFailed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('не отдаёт тело ошибочного ответа или исходное исключение транспорта', async () => {
    fetchMock.mockResolvedValueOnce(new Response(syntheticUrl, { status: 400 }));
    fetchMock.mockRejectedValueOnce(new Error(syntheticUrl));
    for (let i = 0; i < 2; i++) {
      await expect(stageProtectedData(profile, sessionId, fields)).rejects.toMatchObject({ code: 'stageFailed', message: 'stageFailed' });
    }
  });
});
