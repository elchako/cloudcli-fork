import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isSealedSecret, openSecret, resetSecretKeyCache, sealSecret } from '../secret-box.js';

/** Runs `body` with a throwaway key directory and a clean key cache. */
function withTemporaryKey<T>(body: (keyDirectory: string) => T): T {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousSecretKey = process.env.CLOUDCLI_SECRET_KEY;
  const keyDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudcli-secret-'));

  process.env.DATABASE_PATH = path.join(keyDirectory, 'auth.db');
  delete process.env.CLOUDCLI_SECRET_KEY;
  resetSecretKeyCache();

  try {
    return body(keyDirectory);
  } finally {
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousSecretKey === undefined) delete process.env.CLOUDCLI_SECRET_KEY;
    else process.env.CLOUDCLI_SECRET_KEY = previousSecretKey;
    resetSecretKeyCache();
    fs.rmSync(keyDirectory, { recursive: true, force: true });
  }
}

test('sealed secrets round-trip back to the original plaintext', () => {
  withTemporaryKey(() => {
    const secret = 'sk-voice-abc123';
    const sealed = sealSecret(secret);

    assert.notEqual(sealed, secret);
    assert.ok(!sealed.includes(secret), 'ciphertext must not embed the plaintext');
    assert.equal(openSecret(sealed), secret);
  });
});

test('sealing the same value twice yields different ciphertext', () => {
  withTemporaryKey(() => {
    // A fresh nonce per call: equal keys must not be detectable by comparing
    // stored values across users.
    const first = sealSecret('same-key');
    const second = sealSecret('same-key');

    assert.notEqual(first, second);
    assert.equal(openSecret(first), 'same-key');
    assert.equal(openSecret(second), 'same-key');
  });
});

test('the key file is created once with owner-only permissions', () => {
  withTemporaryKey((keyDirectory) => {
    sealSecret('value');
    const keyPath = path.join(keyDirectory, 'secret.key');

    assert.ok(fs.existsSync(keyPath));
    // 0600: readable only by the user running the server.
    assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
  });
});

test('tampered ciphertext fails authentication instead of returning garbage', () => {
  withTemporaryKey(() => {
    const sealed = sealSecret('sk-original');
    const prefix = 'gcm.v1.';
    const payload = Buffer.from(sealed.slice(prefix.length), 'base64');

    // Flip a bit in the ciphertext body; GCM's auth tag must reject it.
    payload[payload.length - 1] ^= 0x01;
    const tampered = prefix + payload.toString('base64');

    assert.equal(openSecret(tampered), null);
  });
});

test('a value sealed with another key cannot be opened', () => {
  const sealedElsewhere = withTemporaryKey(() => sealSecret('sk-from-host-a'));

  withTemporaryKey(() => {
    // Different key directory → different key. Losing the key must fail closed.
    assert.equal(openSecret(sealedElsewhere), null);
  });
});

test('non-sealed input is rejected rather than treated as a secret', () => {
  withTemporaryKey(() => {
    // Guards the migration path: a cleartext value left in the column must not
    // be mistaken for a valid envelope.
    assert.equal(openSecret('sk-plaintext-leftover'), null);
    assert.equal(openSecret(''), null);
    assert.equal(openSecret(null), null);
    assert.equal(openSecret(undefined), null);
    assert.equal(isSealedSecret('sk-plaintext-leftover'), false);
  });
});

test('CLOUDCLI_SECRET_KEY overrides the key file when it is a valid 32-byte key', () => {
  withTemporaryKey((keyDirectory) => {
    process.env.CLOUDCLI_SECRET_KEY = crypto.randomBytes(32).toString('base64');
    resetSecretKeyCache();

    const sealed = sealSecret('sk-env-key');
    assert.equal(openSecret(sealed), 'sk-env-key');
    // No key file is generated when the environment supplies the key.
    assert.equal(fs.existsSync(path.join(keyDirectory, 'secret.key')), false);
  });
});

test('a malformed CLOUDCLI_SECRET_KEY is rejected loudly, not silently ignored', () => {
  withTemporaryKey(() => {
    // Silently falling back would encrypt under a key the operator did not
    // choose, and the mistake would surface only when secrets stop opening.
    process.env.CLOUDCLI_SECRET_KEY = 'too-short';
    resetSecretKeyCache();

    assert.throws(() => sealSecret('value'), /CLOUDCLI_SECRET_KEY/);
  });
});
