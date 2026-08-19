/**
 * Authenticated encryption for secrets stored at rest (AES-256-GCM).
 *
 * Upstream has no at-rest encryption at all: `user_credentials.credential_value`
 * is written verbatim, and the user-settings blob actively strips anything that
 * looks like a secret. That left the voice STT/TTS apiKey device-local, so
 * clearing the browser cache lost it. This module is the missing primitive:
 * secrets are sealed here before they reach SQLite and opened only server-side.
 *
 * Key material resolution, in order:
 *   1. `CLOUDCLI_SECRET_KEY` — 32 bytes as base64 or hex. Set this to control
 *      the key yourself (e.g. to share one key across hosts, or to keep it out
 *      of the filesystem entirely).
 *   2. `<database dir>/secret.key` — generated on first use with mode 0600.
 *      It lives next to auth.db on purpose: the ciphertext and the key that
 *      opens it must travel together, or moving DATABASE_PATH silently orphans
 *      every stored secret.
 *
 * Threat model, stated plainly: this protects the database file, not the host.
 * An attacker who can read `~/.cloudcli/` reads both the key and the DB, so
 * this is not a defence against a compromised account. It does mean the apiKey
 * no longer sits in cleartext inside a file that gets copied into backups,
 * synced between machines, or handed over when debugging a database.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96-bit nonce, the size GCM is specified for
const AUTH_TAG_BYTES = 16;
const KEY_FILE_NAME = 'secret.key';

// Marks a sealed payload so `openSecret` can reject anything it did not write
// (e.g. a cleartext value left over from before this module existed).
const ENVELOPE_PREFIX = 'gcm.v1.';

let cachedKey: Buffer | null = null;

/** Parses a 32-byte key supplied as base64 or hex; returns null when unusable. */
function parseEnvironmentKey(rawValue: string): Buffer | null {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return null;
  }

  for (const encoding of ['base64', 'hex'] as const) {
    try {
      const decoded = Buffer.from(trimmed, encoding);
      if (decoded.length === KEY_BYTES) {
        return decoded;
      }
    } catch {
      // Try the next encoding.
    }
  }

  return null;
}

/**
 * Reads the key file, creating it on first use. Written with mode 0600 via
 * `wx` so a concurrent starter cannot clobber a key that another process just
 * generated — losing that race would make previously sealed values unopenable.
 */
function loadOrCreateKeyFile(keyDirectory: string): Buffer {
  const keyPath = path.join(keyDirectory, KEY_FILE_NAME);

  if (fs.existsSync(keyPath)) {
    const existing = fs.readFileSync(keyPath);
    const parsed = parseEnvironmentKey(existing.toString('utf8'));
    if (parsed) {
      return parsed;
    }
    throw new Error(
      `Secret key at ${keyPath} is malformed (expected ${KEY_BYTES} bytes as base64). `
      + 'Fix or remove it — removing it makes existing stored secrets unreadable.',
    );
  }

  fs.mkdirSync(keyDirectory, { recursive: true });
  const generated = crypto.randomBytes(KEY_BYTES);
  try {
    fs.writeFileSync(keyPath, generated.toString('base64'), { mode: 0o600, flag: 'wx' });
    return generated;
  } catch (error) {
    // Another process won the race: adopt the key it wrote rather than ours.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const winner = parseEnvironmentKey(fs.readFileSync(keyPath).toString('utf8'));
      if (winner) {
        return winner;
      }
    }
    throw error;
  }
}

/** Directory holding the key: alongside the database, or the home fallback. */
function resolveKeyDirectory(): string {
  const databasePath = process.env.DATABASE_PATH;
  if (databasePath) {
    return path.dirname(path.resolve(databasePath));
  }
  return path.join(os.homedir(), '.cloudcli');
}

/** Returns the process-wide encryption key, resolving it on first call. */
function getKey(): Buffer {
  if (cachedKey) {
    return cachedKey;
  }

  const fromEnvironment = process.env.CLOUDCLI_SECRET_KEY
    ? parseEnvironmentKey(process.env.CLOUDCLI_SECRET_KEY)
    : null;

  if (process.env.CLOUDCLI_SECRET_KEY && !fromEnvironment) {
    throw new Error(
      `CLOUDCLI_SECRET_KEY must be ${KEY_BYTES} bytes encoded as base64 or hex.`,
    );
  }

  cachedKey = fromEnvironment ?? loadOrCreateKeyFile(resolveKeyDirectory());
  return cachedKey;
}

/** Drops the cached key. Tests use this after pointing env vars elsewhere. */
export function resetSecretKeyCache(): void {
  cachedKey = null;
}

/** True when the value carries this module's envelope (i.e. is sealed). */
export function isSealedSecret(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(ENVELOPE_PREFIX);
}

/**
 * Seals a plaintext secret. The nonce is random per call, so sealing the same
 * value twice yields different ciphertext — callers must not compare sealed
 * strings to test equality.
 */
export function sealSecret(plaintext: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return ENVELOPE_PREFIX + Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

/**
 * Opens a sealed secret, or returns null when the value is not sealed, was
 * truncated, or fails authentication (wrong key / tampered ciphertext). Callers
 * treat null as "no usable secret" rather than crashing a request.
 */
export function openSecret(sealed: unknown): string | null {
  if (!isSealedSecret(sealed)) {
    return null;
  }

  try {
    const payload = Buffer.from(sealed.slice(ENVELOPE_PREFIX.length), 'base64');
    if (payload.length <= IV_BYTES + AUTH_TAG_BYTES) {
      return null;
    }

    const iv = payload.subarray(0, IV_BYTES);
    const authTag = payload.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
    const ciphertext = payload.subarray(IV_BYTES + AUTH_TAG_BYTES);

    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key, tampered payload or malformed base64 — all mean "unusable".
    return null;
  }
}
