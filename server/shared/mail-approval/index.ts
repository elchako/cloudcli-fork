// GOLDJAXE fork (реестр §23): подписант доступен только из authenticated WS round trip.
import { constants, openSync, readFileSync, fstatSync, closeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify, type KeyObject } from 'node:crypto';

import type { ElicitationRequest, ElicitationResult } from '@anthropic-ai/claude-agent-sdk';
import type { WebSocket } from 'ws';
import { z } from 'zod';

export const MAIL_APPROVAL_PREFIX = 'MAIL-MCP-LOCAL-APPROVAL-V1\n';
const SERVER_NAME = 'mail-local';
const text = z.string().min(1).max(512);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const challengeSchema = z.object({
  version: z.literal(1), audience: z.literal('cloudcli-local-mail'),
  tenant_id: text, user_id: text, client_id: text, draft_id: text, revision: integer,
  preview: z.record(z.string(), z.json()), preview_hash: hash, eml_sha256: hash,
  nonce: z.string().uuid(), issued_at: integer, expires_at: integer,
}).strict();
const envelopeSchema = z.object({ payload: challengeSchema, key_id: text, signature: text }).strict();
const configSchema = z.object({
  private_key_path: text, key_id: text,
  authorities: z.array(z.object({
    tenant_id: text, user_id: text, client_id: text, cloudcli_user_id: text,
    challenge_public_keys: z.record(text, text),
  }).strict()).min(1),
}).strict();

type Challenge = z.infer<typeof challengeSchema>;
type Config = z.infer<typeof configSchema>;
type Envelope = { payload: Record<string, unknown>; key_id: string; signature: string };
type Decision = { allow?: unknown; cancelled?: unknown; updatedInput?: unknown } | null;
type Pending = {
  challenge: Challenge; userId: string; sessionId: string;
  answered: boolean; token?: Envelope;
};

/** Python sort_keys=True сортирует Unicode code points, не UTF-16 и не integer keys JS. */
function compareKeys(a: string, b: string): number {
  const left = Array.from(a, c => c.codePointAt(0)!);
  const right = Array.from(b, c => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return left.length - right.length;
}

export function canonicalMailJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  // Даты, revision и размеры v1 целочисленные. Не угадываем Python float encoding.
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalMailJson).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort(compareKeys).map(key => `${JSON.stringify(key)}:${canonicalMailJson(object[key])}`).join(',')}}`;
  }
  throw new Error('Некорректный формат локального подтверждения Mail');
}

export function mailSigningBytes(purpose: 'local-approval-challenge' | 'local-human-decision', payload: unknown): Buffer {
  return Buffer.from(`mail-mcp:${purpose}:v1\0${canonicalMailJson(payload)}`, 'utf8');
}

function decodeBase64url(value: string, length: number): Buffer {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) throw new Error('Invalid encoding');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== length || bytes.toString('base64url') !== value.replace(/=+$/, '')) throw new Error('Invalid encoding');
  return bytes;
}

/** Не следуем symlink; права и владелец проверяются на том же открытом inode. */
function readAdminFile(file: string, privateKey: boolean): string {
  if (!isAbsolute(file)) throw new Error('Absolute path required');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.size > 1024 * 1024
      || (privateKey ? (stat.mode & 0o777) !== 0o600 : (stat.mode & 0o022) !== 0)) throw new Error('Unsafe admin file');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

function loadConfig(file: string): { config: Config; key: KeyObject } {
  try {
    const config = configSchema.parse(JSON.parse(readAdminFile(file, false)));
    const pem = readAdminFile(config.private_key_path, true);
    if (!pem.startsWith('-----BEGIN PRIVATE KEY-----')) throw new Error('PKCS8 required');
    const key = createPrivateKey({ key: pem, format: 'pem', type: 'pkcs8' });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 required');
    const scopes = new Set<string>();
    for (const authority of config.authorities) {
      const scope = canonicalMailJson([authority.tenant_id, authority.user_id, authority.client_id, authority.cloudcli_user_id]);
      if (scopes.has(scope) || Object.keys(authority.challenge_public_keys).length === 0) throw new Error('Invalid authorities');
      scopes.add(scope);
      for (const raw of Object.values(authority.challenge_public_keys)) decodeBase64url(raw, 32);
    }
    return { config, key };
  } catch {
    // Не выдаём ни путь ключа, ни исходный JSON, ни содержимое ошибки парсера.
    throw new Error('Некорректная административная конфигурация локального подтверждения Mail');
  }
}

const CONFIRM_SCHEMA = {
  type: 'object', properties: { confirm: { type: 'boolean', title: 'Отправить это письмо', default: false } }, required: ['confirm'],
};

export function isLocalMailApprovalRequest(request: Pick<ElicitationRequest, 'message'>): boolean {
  return typeof request.message === 'string' && request.message.startsWith(MAIL_APPROVAL_PREFIX);
}

/** Отдельный реестр, а не расширение generic resolver. Ключи загружаются при старте. */
export class LocalMailApproval {
  readonly #settings: ReturnType<typeof loadConfig> | undefined;
  readonly #pending = new Map<string, Pending>();
  readonly #nonces = new Map<string, number>();
  constructor(configPath?: string, private readonly now: () => number = Date.now) {
    this.#settings = configPath ? loadConfig(configPath) : undefined;
  }

  register(request: ElicitationRequest, requestId: string, userId: unknown, sessionId: unknown) {
    try {
      const settings = this.#settings;
      if (!settings || request.serverName !== SERVER_NAME || (request.mode && request.mode !== 'form')
        || request.url || !isLocalMailApprovalRequest(request)
        || typeof sessionId !== 'string' || !sessionId || userId == null
        || !requestId || this.#pending.has(requestId)
        || canonicalMailJson(request.requestedSchema) !== canonicalMailJson(CONFIRM_SCHEMA)) throw new Error('Invalid request');
      const envelope = envelopeSchema.parse(JSON.parse(request.message.slice(MAIL_APPROVAL_PREFIX.length)));
      const challenge = envelope.payload;
      const authenticatedUserId = String(userId);
      const authority = settings.config.authorities.find(a => a.tenant_id === challenge.tenant_id
        && a.user_id === challenge.user_id && a.client_id === challenge.client_id && a.cloudcli_user_id === authenticatedUserId);
      const rawKey = authority?.challenge_public_keys[envelope.key_id];
      if (!rawKey) throw new Error('Unknown authority');
      const publicKey = createPublicKey({
        key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), decodeBase64url(rawKey, 32)]),
        format: 'der', type: 'spki',
      });
      if (!verify(null, mailSigningBytes('local-approval-challenge', challenge), publicKey, decodeBase64url(envelope.signature, 64))) throw new Error('Invalid signature');
      const now = this.now();
      if (challenge.issued_at > now || challenge.expires_at <= now || challenge.expires_at <= challenge.issued_at
        || challenge.expires_at - challenge.issued_at > 300_000
        || createHash('sha256').update(canonicalMailJson(challenge.preview)).digest('hex') !== challenge.preview_hash) throw new Error('Invalid challenge');
      for (const [nonce, expiry] of this.#nonces) if (expiry <= now) this.#nonces.delete(nonce);
      const nonceKey = canonicalMailJson([challenge.tenant_id, challenge.user_id, challenge.client_id, challenge.nonce]);
      if (this.#nonces.has(nonceKey) || this.#nonces.size >= 10_000) throw new Error('Repeated challenge');
      this.#nonces.set(nonceKey, challenge.expires_at);
      const entry: Pending = { challenge, userId: authenticatedUserId, sessionId, answered: false };
      this.#pending.set(requestId, entry);
      // Отдельная копия для UI: ни модель, ни updatedInput не меняют подписываемый снимок.
      const input = {
        serverName: SERVER_NAME, mode: 'form', message: 'Проверьте полное письмо перед отправкой.',
        localMailPreview: JSON.parse(canonicalMailJson(challenge.preview)) as Record<string, unknown>,
        requestedSchema: structuredClone(CONFIRM_SCHEMA),
      };
      return {
        input,
        timeoutMs: challenge.expires_at - now,
        finish: (decision: Decision): ElicitationResult => {
          const active = this.#pending.get(requestId) === entry;
          if (active) this.#pending.delete(requestId);
          if (!active || !decision || decision.cancelled || challenge.expires_at <= this.now()) return { action: 'cancel' };
          if (decision.allow !== true) return { action: 'decline' };
          // Даже raw SDK accept с поддельным token в updatedInput не является доказательством.
          if (!entry.token) return { action: 'cancel' };
          // MCP ElicitResult допускает только примитивы: envelope идёт canonical JSON строкой.
          return { action: 'accept', content: { confirm: true, local_mail_decision: canonicalMailJson(entry.token) } };
        },
        dispose: () => { if (this.#pending.get(requestId) === entry) this.#pending.delete(requestId); },
      };
    } catch {
      // Fail closed, без challenge/preview/подписей в логах и уведомлениях.
      return null;
    }
  }

  /**
   * Вызывается только handleChatConnection после проверки auth upgrade. Возвращённая
   * функция живёт в замыкании socket listener, не передаётся SDK, hooks или resolver.
   */
  bindAuthenticatedConnection(ws: WebSocket, authenticatedUserId: string | number | null) {
    const userId = authenticatedUserId == null ? null : String(authenticatedUserId);
    return (data: Record<string, unknown>, sessionExists: boolean): boolean => {
      const requestId = typeof data.requestId === 'string' ? data.requestId : '';
      const entry = this.#pending.get(requestId);
      if (!entry) return false;
      // true означает "Mail обработан, в generic resolver не передавать".
      if (ws.readyState !== 1 || !userId || userId !== entry.userId || !sessionExists
        || data.sessionId !== entry.sessionId || data.type !== 'chat.permission-response') return true;
      if (entry.answered) return true;
      const updated = data.updatedInput;
      if (data.allow === true && (!updated || typeof updated !== 'object' || Array.isArray(updated)
        || Object.keys(updated).length !== 1 || (updated as Record<string, unknown>).confirm !== true)) {
        return true;
      }
      entry.answered = true;
      const now = this.now();
      if (data.allow === true && now < entry.challenge.expires_at) {
        const c = entry.challenge;
        const payload = {
          version: 1, channel: 'cloudcli_native', decision: 'approve',
          tenant_id: c.tenant_id, user_id: c.user_id, client_id: c.client_id,
          draft_id: c.draft_id, revision: c.revision, preview_hash: c.preview_hash, eml_sha256: c.eml_sha256,
          challenge_nonce: c.nonce, cloudcli_user_id: userId, conversation_id: entry.sessionId,
          request_id: requestId, event_id: randomUUID(), issued_at: now, expires_at: Math.min(now + 60_000, c.expires_at),
        };
        const settings = this.#settings!;
        entry.token = {
          payload, key_id: settings.config.key_id,
          signature: sign(null, mailSigningBytes('local-human-decision', payload), settings.key).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
        };
      }
      return false; // Только этот подлинный WS-ответ можно теперь передать ожидающему resolver.
    };
  }
}

// Opt-in, без генерации ключей и без чтения ~/.cloudcli. Ошибочный opt-in останавливает запуск.
export const localMailApproval = new LocalMailApproval(process.env.CLOUDCLI_MAIL_APPROVAL_CONFIG);
