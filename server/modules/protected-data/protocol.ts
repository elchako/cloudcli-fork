import { Buffer } from 'node:buffer';
import { createPublicKey } from 'node:crypto';

// GOLDJAXE fork (реестр §27): общий wire-контракт CloudCLI и изолированного исполнителя.
export const PROTECTED_DATA_MAX_FIELDS = 12;
export const PROTECTED_DATA_MAX_VALUE_BYTES = 4096;
export const PROTECTED_DATA_MAX_BODY_BYTES = 400 * 1024;
export const PROTECTED_DATA_TTL_MS = 30 * 60_000;
export const PROTECTED_DATA_CLOCK_SKEW_MS = 30_000;
export const PROTECTED_DATA_MIN_RSA_BITS = 2048;
export const PROTECTED_DATA_MAX_RSA_BITS = 8192;
export const PROTECTED_DATA_GCM_TAG_BYTES = 16;

// JSON может записать один байт значения шестью байтами (\u0000).
const MAX_CIPHERTEXT_BYTES = 2 + PROTECTED_DATA_MAX_FIELDS * (6 * PROTECTED_DATA_MAX_VALUE_BYTES + 3)
  + PROTECTED_DATA_GCM_TAG_BYTES;
const MAX_SPKI_BYTES = PROTECTED_DATA_MAX_RSA_BITS / 8 + 128;
const REVISION = /^[0-9a-f]{64}$/i;
const SESSION_ID = /^[A-Za-z0-9_.:-]{1,256}$/;
const NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALIAS = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const PROFILE_FIELDS = ['revision', 'publicKey', 'label', 'requiredFields', 'urlField', 'operation', 'targets'];
const ENVELOPE_FIELDS = ['version', 'revision', 'sessionId', 'nonce', 'issuedAt', 'names', 'wrappedKey', 'iv', 'ciphertext', 'target'];

export interface ProtectedDataProfile {
  revision: string;
  publicKey: string;
  label: string;
  requiredFields: string[];
  urlField?: string;
  operation?: 'local-check' | 'apply' | 'env-apply';
  targets?: Array<{ id: string; label: string }>;
}

export interface ProtectedDataEnvelope {
  version: 1;
  revision: string;
  sessionId: string;
  nonce: string;
  issuedAt: number;
  names: string[];
  wrappedKey: string;
  iv: string;
  ciphertext: string;
  target?: string;
}

export type ProtectedDataStatus = 'ok' | 'received' | 'delivered' | 'applied' | 'denied' | 'failed' | 'invalid' | 'expired' | 'used';

function hasOnlyFields(value: unknown, fields: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => fields.includes(key));
}

export function isProtectedDataAlias(value: unknown): value is string {
  return typeof value === 'string' && ALIAS.test(value);
}

export function validSelection(names: readonly string[], available: readonly string[]): boolean {
  return names.length > 0 && names.length <= available.length && new Set(names).size === names.length
    && names.every(name => isProtectedDataAlias(name) && available.includes(name));
}

export function isProtectedDataTargetId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(value);
}

export function isProtectedDataLabel(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && Buffer.byteLength(value, 'utf8') <= 256
    && value.trim().length > 0 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function readNames(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > PROTECTED_DATA_MAX_FIELDS) return null;
  const names: string[] = [];
  for (const name of value) {
    if (!isProtectedDataAlias(name) || names.includes(name)) return null;
    names.push(name);
  }
  return names;
}

function readBase64(value: unknown, minBytes: number, maxBytes: number): Buffer | null {
  if (typeof value !== 'string' || value.length % 4 !== 0
    || value.length < 4 * Math.ceil(minBytes / 3) || value.length > 4 * Math.ceil(maxBytes / 3)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length >= minBytes && bytes.length <= maxBytes && bytes.toString('base64') === value ? bytes : null;
}

function isPublicKey(value: unknown): value is string {
  const der = readBase64(value, PROTECTED_DATA_MIN_RSA_BITS / 8, MAX_SPKI_BYTES);
  if (!der) return false;
  try {
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
    return key.asymmetricKeyType === 'rsa' && bits >= PROTECTED_DATA_MIN_RSA_BITS
      && bits <= PROTECTED_DATA_MAX_RSA_BITS && der.equals(key.export({ format: 'der', type: 'spki' }));
  } catch {
    return false;
  }
}

export function readProtectedDataProfile(value: unknown): ProtectedDataProfile | null {
  if (!hasOnlyFields(value, PROFILE_FIELDS)) return null;
  const { revision, publicKey, label, urlField, operation } = value;
  if (typeof revision !== 'string' || !REVISION.test(revision) || !isProtectedDataLabel(label) || !isPublicKey(publicKey)) return null;
  if (operation === 'env-apply') {
    if (!Array.isArray(value.targets) || !value.targets.length || value.targets.length > 16
      || urlField !== undefined || !Array.isArray(value.requiredFields) || value.requiredFields.length) return null;
    const targets: NonNullable<ProtectedDataProfile['targets']> = [];
    for (const item of value.targets) {
      if (!hasOnlyFields(item, ['id', 'label']) || !isProtectedDataTargetId(item.id) || !isProtectedDataLabel(item.label)
        || targets.some(t => t.id === item.id)) return null;
      targets.push({ id: item.id, label: item.label });
    }
    return { revision, publicKey, label, requiredFields: [], operation, targets };
  }
  if (value.targets !== undefined) return null;
  if (operation === 'local-check' && urlField === undefined && Array.isArray(value.requiredFields) && value.requiredFields.length === 0) {
    return { revision, publicKey, label, requiredFields: [], operation };
  }
  const requiredFields = readNames(value.requiredFields);
  if (operation === 'apply' && urlField === undefined && requiredFields?.length === 1) {
    return { revision, publicKey, label, requiredFields, operation };
  }
  if (operation !== undefined || !requiredFields) return null;
  if (urlField === undefined) return { revision, publicKey, label, requiredFields };
  if (!isProtectedDataAlias(urlField) || requiredFields.length >= PROTECTED_DATA_MAX_FIELDS
    || requiredFields.includes(urlField)) return null;
  return { revision, publicKey, label, requiredFields, urlField };
}

export function readProtectedDataEnvelope(value: unknown): ProtectedDataEnvelope | null {
  if (!hasOnlyFields(value, ENVELOPE_FIELDS)) return null;
  const { version, revision, sessionId, nonce, issuedAt, wrappedKey, iv, ciphertext } = value;
  const names = readNames(value.names);
  if (version !== 1 || typeof revision !== 'string' || !REVISION.test(revision)
    || typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) || typeof nonce !== 'string' || !NONCE.test(nonce)
    || typeof issuedAt !== 'number' || !Number.isSafeInteger(issuedAt) || issuedAt < 0 || !names
    || typeof wrappedKey !== 'string' || !readBase64(wrappedKey, PROTECTED_DATA_MIN_RSA_BITS / 8, PROTECTED_DATA_MAX_RSA_BITS / 8)
    || typeof iv !== 'string' || !readBase64(iv, 12, 12)
    || typeof ciphertext !== 'string' || !readBase64(ciphertext, PROTECTED_DATA_GCM_TAG_BYTES + 1, MAX_CIPHERTEXT_BYTES)) return null;
  const { target } = value;
  if (target !== undefined && !isProtectedDataTargetId(target)) return null;
  return { version, revision, sessionId, nonce, issuedAt, names, wrappedKey, iv, ciphertext, ...(target === undefined ? {} : { target }) };
}

export function readProtectedDataStatus(value: unknown): ProtectedDataStatus | null {
  switch (value) {
    case 'ok': case 'received': case 'delivered': case 'applied': case 'denied': case 'failed': case 'invalid': case 'expired': case 'used':
      return value;
    default:
      return null;
  }
}

export function protectedDataAad(envelope: Pick<ProtectedDataEnvelope, 'revision' | 'sessionId' | 'nonce' | 'issuedAt' | 'names' | 'target'>): Buffer {
  return Buffer.from(JSON.stringify([1, envelope.revision, envelope.sessionId, envelope.nonce, envelope.issuedAt, envelope.names,
    ...(envelope.target === undefined ? [] : [envelope.target])]), 'utf8');
}
