import { authenticatedFetch } from '@/shared/api';

// GOLDJAXE fork (реестр §27): значения покидают браузер только в зашифрованном конверте.
export type ProtectedField = { name: string; value: string };

export type ProtectedDataProfile = {
  revision: string;
  publicKey: string;
  label: string;
  requiredFields: string[];
  urlField?: string;
  operation?: 'local-check' | 'apply' | 'env-apply';
  targets?: { id: string; label: string }[];
};

export const MAX_PROTECTED_FIELDS = 12;
const MAX_VALUE_BYTES = 4096;
const MAX_PLAINTEXT_BYTES = 60 * 1024;
const ENDPOINT = '/api/protected-data';
const ALIAS = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const encoder = new TextEncoder();

export type ProtectedDataIssue =
  | { code: 'invalidCount' | 'missingRequired' | 'tooLarge' }
  | { code: 'invalidName' | 'duplicateName' | 'emptyValue' | 'valueTooLarge'; row: number; field: keyof ProtectedField };

type ErrorCode = ProtectedDataIssue['code']
  | 'profileUnavailable' | 'invalidProfile' | 'invalidTarget' | 'insecureContext' | 'invalidSession' | 'encryptionFailed' | 'stageFailed';

export class ProtectedDataError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
    this.name = 'ProtectedDataError';
  }
}

function isAlias(value: unknown): value is string {
  return typeof value === 'string' && ALIAS.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readTargets(value: unknown): NonNullable<ProtectedDataProfile['targets']> {
  if (!Array.isArray(value) || value.length === 0) throw new ProtectedDataError('invalidProfile');
  const ids = new Set<string>();
  return value.map((item: unknown) => {
    if (!isRecord(item) || typeof item.id !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(item.id)
        || ids.has(item.id) || typeof item.label !== 'string' || !item.label.trim()) {
      throw new ProtectedDataError('invalidProfile');
    }
    ids.add(item.id);
    return { id: item.id, label: item.label };
  });
}

function readProfile(value: unknown): ProtectedDataProfile {
  if (!isRecord(value)) throw new ProtectedDataError('invalidProfile');
  const { revision, publicKey, label, requiredFields, urlField, operation } = value;
  if (typeof revision !== 'string' || !/^[0-9a-f]{64}$/i.test(revision)
      || typeof publicKey !== 'string' || publicKey.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(publicKey)
      || typeof label !== 'string' || !label.trim()
      || !Array.isArray(requiredFields) || requiredFields.length > MAX_PROTECTED_FIELDS
      || !requiredFields.every(isAlias) || new Set(requiredFields).size !== requiredFields.length
      || (urlField !== undefined && !isAlias(urlField))
      || (operation !== undefined && operation !== 'local-check' && operation !== 'apply' && operation !== 'env-apply')
      || (operation !== 'env-apply' && value.targets !== undefined)
      || ((operation === 'local-check' || operation === 'env-apply') && (urlField !== undefined || requiredFields.length !== 0))
      || (operation === 'apply' && (urlField !== undefined || requiredFields.length !== 1))) {
    throw new ProtectedDataError('invalidProfile');
  }
  return { revision, publicKey, label, requiredFields: [...requiredFields],
    ...(operation === 'env-apply' ? { targets: readTargets(value.targets) } : {}),
    ...(urlField === undefined ? {} : { urlField }), ...(operation === undefined ? {} : { operation }) };
}

export async function loadProtectedDataProfile(signal?: AbortSignal): Promise<ProtectedDataProfile | null> {
  let data: unknown;
  try {
    const response = await authenticatedFetch(ENDPOINT, { method: 'GET', signal, redirect: 'error' });
    if (response.status === 503) return null;
    if (!response.ok) throw new ProtectedDataError('profileUnavailable');
    data = await response.json();
  } catch {
    if (signal?.aborted) throw new DOMException('Запрос отменён', 'AbortError');
    throw new ProtectedDataError('profileUnavailable');
  }
  return readProfile(data);
}

function prepareFields(profile: ProtectedDataProfile, fields: readonly ProtectedField[]):
  | { issue: ProtectedDataIssue }
  | { names: string[]; plaintext: Uint8Array<ArrayBuffer> } {
  if (fields.length === 0 || fields.length > MAX_PROTECTED_FIELDS) return { issue: { code: 'invalidCount' } };
  const names = new Set<string>();
  const values: string[] = [];
  for (const [row, { name, value }] of fields.entries()) {
    if (!isAlias(name)) return { issue: { code: 'invalidName', row, field: 'name' } };
    if (names.has(name)) return { issue: { code: 'duplicateName', row, field: 'name' } };
    if (typeof value !== 'string' || value.length === 0) return { issue: { code: 'emptyValue', row, field: 'value' } };
    if (value.length > MAX_VALUE_BYTES) return { issue: { code: 'valueTooLarge', row, field: 'value' } };
    const bytes = encoder.encode(value);
    bytes.fill(0);
    if (bytes.length > MAX_VALUE_BYTES) return { issue: { code: 'valueTooLarge', row, field: 'value' } };
    names.add(name);
    values.push(value);
  }
  if (!profile.requiredFields.every((name) => names.has(name))) return { issue: { code: 'missingRequired' } };
  const plaintext = encoder.encode(JSON.stringify(values));
  if (plaintext.length > MAX_PLAINTEXT_BYTES) {
    plaintext.fill(0);
    return { issue: { code: 'tooLarge' } };
  }
  return { names: [...names], plaintext };
}

export function validateProtectedFields(profile: ProtectedDataProfile, fields: readonly ProtectedField[]): ProtectedDataIssue | null {
  const prepared = prepareFields(profile, fields);
  if ('issue' in prepared) return prepared.issue;
  prepared.plaintext.fill(0);
  return null;
}

function toBase64(buffer: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function stageProtectedData(
  profile: ProtectedDataProfile,
  sessionId: string,
  fields: readonly ProtectedField[],
  target?: string,
): Promise<string> {
  const crypto = globalThis.crypto;
  if (globalThis.isSecureContext !== true || !crypto?.subtle || typeof crypto.randomUUID !== 'function') {
    throw new ProtectedDataError('insecureContext');
  }
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(sessionId)) throw new ProtectedDataError('invalidSession');
  const safeProfile = readProfile(profile);
  const { revision, publicKey, targets } = safeProfile;
  if (targets ? !targets.some(({ id }) => id === target) : target !== undefined) {
    throw new ProtectedDataError('invalidTarget');
  }
  const prepared = prepareFields(safeProfile, fields);
  if ('issue' in prepared) throw new ProtectedDataError(prepared.issue.code);
  const { names, plaintext } = prepared;

  let body: string;
  try {
    const rsaKey = await crypto.subtle.importKey(
      'spki', Uint8Array.from(atob(publicKey), (char) => char.charCodeAt(0)),
      { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['wrapKey'],
    );
    const aesKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
    const nonce = crypto.randomUUID();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const issuedAt = Date.now();
    const aad = encoder.encode(JSON.stringify([1, revision, sessionId, nonce, issuedAt, names, ...(target === undefined ? [] : [target])]));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, aesKey, plaintext);
    const wrappedKey = await crypto.subtle.wrapKey('raw', aesKey, rsaKey, 'RSA-OAEP');
    body = JSON.stringify({
      version: 1, revision, sessionId, nonce, issuedAt, names, target,
      wrappedKey: toBase64(wrappedKey), iv: toBase64(iv.buffer), ciphertext: toBase64(ciphertext),
    });
  } catch {
    throw new ProtectedDataError('encryptionFailed');
  } finally {
    plaintext.fill(0);
  }

  try {
    const response = await authenticatedFetch(ENDPOINT, { method: 'POST', redirect: 'error', body });
    if (!response.ok) throw new ProtectedDataError('stageFailed');
    const data: unknown = await response.json();
    if (isRecord(data) && typeof data.id === 'string' && data.id.trim()) return data.id;
  } catch {
    // Исключения транспорта и содержимое ответа не передаём в интерфейс.
  }
  throw new ProtectedDataError('stageFailed');
}
