import { createHash, randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { request } from 'node:http';
import { isAbsolute } from 'node:path';

import type { ProviderRuntimeWriter } from '@/shared/types.js';

import {
  PROTECTED_DATA_CLOCK_SKEW_MS,
  PROTECTED_DATA_TTL_MS,
  readProtectedDataProfile,
  readProtectedDataStatus,
  type ProtectedDataEnvelope,
  type ProtectedDataProfile,
  type ProtectedDataStatus,
} from './protocol.js';
import { createMemoryProtectedDataExecutor } from './executor.js';
import { readApplyReceiver } from './apply-receiver.js';

// GOLDJAXE fork (реестр §27): на стороне CloudCLI только конверты и метки.
const STAGED_LIMIT = 128;
const NONCE_LIMIT = 2048;
const RESPONSE_LIMIT = 8 * 1024;
const GRANT_ID = /^[a-f0-9-]{36}$/;

type ExecutorRequest = (route: '/v1/profile' | '/v1/execute', body?: ProtectedDataEnvelope) => Promise<unknown>;

function executorRequest(route: '/v1/profile' | '/v1/execute', body?: ProtectedDataEnvelope): Promise<unknown> {
  return new Promise((resolve) => {
    const socketPath = process.env.CLOUDCLI_PROTECTED_DATA_SOCKET;
    if (!socketPath || !isAbsolute(socketPath)) return resolve(null);
    try {
      const socket = lstatSync(socketPath);
      // Не обещаем изоляцию, запуская оба процесса от одного UID.
      const ownUid = process.getuid?.();
      if (!socket.isSocket() || ownUid == null || ownUid === 0 || ownUid === socket.uid) return resolve(null);
      const payload = body ? JSON.stringify(body) : undefined;
      const req = request({
        socketPath,
        path: route,
        method: payload ? 'POST' : 'GET',
        signal: AbortSignal.timeout(payload ? 12_000 : 2_000),
        headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : undefined,
      }, (res) => {
        if (res.statusCode !== 200) {
          res.destroy();
          resolve(null);
          return;
        }
        const parts: Buffer[] = [];
        let bytes = 0;
        res.on('error', () => resolve(null));
        res.on('data', (part: Buffer) => {
          bytes += part.length;
          if (bytes > RESPONSE_LIMIT) {
            res.destroy();
            resolve(null);
          } else {
            parts.push(part);
          }
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(parts).toString('utf8')));
          } catch {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.end(payload);
    } catch {
      resolve(null);
    }
  });
}

export type ProtectedDataRunGrant = {
  envelope: ProtectedDataEnvelope;
  operation?: ProtectedDataProfile['operation'];
  destinationLabel?: string;
};

type StagedGrant = ProtectedDataRunGrant & { userId: string };

export function createProtectedDataRelay({
  call = executorRequest,
  pinnedKey = () => process.env.CLOUDCLI_PROTECTED_DATA_KEY_SHA256,
  now = Date.now,
  mode = process.env.CLOUDCLI_PROTECTED_DATA_MODE === 'memory' ? 'memory' : 'socket',
}: { call?: ExecutorRequest; pinnedKey?: () => string | undefined; now?: () => number; mode?: 'memory' | 'socket' } = {}) {
  // GOLDJAXE fork (реестр §27.2): не обращаться к сокету или настроенному API
  // в режиме памяти. Ключ создаём только при первом обращении к профилю.
  let memory: ReturnType<typeof createMemoryProtectedDataExecutor> | undefined;
  const memoryExecutor = () => (memory ??= createMemoryProtectedDataExecutor(now,
    readApplyReceiver(process.env.CLOUDCLI_PROTECTED_DATA_APPLY_CONFIG)));
  const staged = new Map<string, StagedGrant>();
  const nonces = new Set<string>();
  const bound = new WeakMap<ProviderRuntimeWriter, ProtectedDataRunGrant>();
  const active = new WeakMap<ProviderRuntimeWriter, number>();

  async function getProfile(): Promise<ProtectedDataProfile | null> {
    try {
      if (mode === 'memory') return memoryExecutor().profile;
      const pin = pinnedKey();
      if (!pin || !/^[0-9a-f]{64}$/.test(pin)) return null;
      const profile = readProtectedDataProfile(await call('/v1/profile'));
      if (!profile || createHash('sha256').update(Buffer.from(profile.publicKey, 'base64')).digest('hex') !== pin) return null;
      return profile;
    } catch {
      return null;
    }
  }

  const isFresh = (e: ProtectedDataEnvelope) => {
    const age = now() - e.issuedAt;
    return age >= -PROTECTED_DATA_CLOCK_SKEW_MS && age < PROTECTED_DATA_TTL_MS;
  };

  return {
    getProfile,
    async stage(userId: string, envelope: ProtectedDataEnvelope): Promise<string | null> {
      const profile = await getProfile();
      const nonce = `${envelope.revision}:${envelope.nonce}`.toLowerCase();
      if (!profile || envelope.revision !== profile.revision || !isFresh(envelope)
        || !profile.requiredFields.every((name) => envelope.names.includes(name))
        || staged.size >= STAGED_LIMIT || nonces.size >= NONCE_LIMIT || nonces.has(nonce)) return null;
      const id = randomUUID();
      nonces.add(nonce);
      setTimeout(() => {
        staged.delete(id);
        nonces.delete(nonce);
      }, envelope.issuedAt + PROTECTED_DATA_TTL_MS - now()).unref();
      staged.set(id, { userId, envelope, operation: profile.operation,
        ...(profile.operation === 'apply' ? { destinationLabel: profile.label } : {}) });
      return id;
    },
    prepare(userId: string, sessionId: string, id: unknown) {
      if (typeof id !== 'string' || !GRANT_ID.test(id)) return null;
      const entry = staged.get(id);
      if (!entry || entry.userId !== userId || entry.envelope.sessionId !== sessionId || !isFresh(entry.envelope)) return null;
      return (writer: ProviderRuntimeWriter) => {
        if (staged.get(id) !== entry || !isFresh(entry.envelope)) return false;
        staged.delete(id);
        const { userId: _userId, ...grant } = entry;
        bound.set(writer, grant);
        active.set(writer, entry.envelope.issuedAt + PROTECTED_DATA_TTL_MS);
        return true;
      };
    },
    take(writer: ProviderRuntimeWriter): ProtectedDataRunGrant | undefined {
      const grant = bound.get(writer);
      bound.delete(writer);
      return grant && isFresh(grant.envelope) ? grant : undefined;
    },
    wasBound(writer: ProviderRuntimeWriter): boolean {
      return active.has(writer);
    },
    isActive(writer: ProviderRuntimeWriter): boolean {
      return (active.get(writer) ?? 0) > now();
    },
    forget(writer: ProviderRuntimeWriter): void {
      if (active.has(writer)) active.set(writer, 0);
      bound.delete(writer);
    },
    async execute(envelope: ProtectedDataEnvelope): Promise<ProtectedDataStatus> {
      if (!isFresh(envelope)) return 'expired';
      try {
        if (mode === 'memory') return await memoryExecutor().execute(envelope);
        const result = await call('/v1/execute', envelope);
        return result && typeof result === 'object' && 'status' in result
          ? readProtectedDataStatus(result.status) ?? 'failed'
          : 'failed';
      } catch {
        return 'failed';
      }
    },
  };
}

export const protectedDataRelay = createProtectedDataRelay();
