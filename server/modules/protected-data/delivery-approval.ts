import { randomUUID } from 'node:crypto';

import type { WebSocket } from 'ws';

import type { ProviderRuntimeWriter } from '@/shared/types.js';

import type { ConfirmDelivery } from './chat-destination.js';
import { isProtectedDataAlias, PROTECTED_DATA_MAX_FIELDS } from './protocol.js';

// GOLDJAXE fork (реестр §27.5): отдельное разрешение, не SDK tool permission.
const APPROVAL_TTL_MS = 3 * 60_000;
const DECISION = 'chat.protected-delivery-decision';
const TOOL = 'CloudCLIProtectedDelivery';
type Turn = { confirm: (isCurrent: () => boolean, expiresAt: number, ...args: Parameters<ConfirmDelivery>) => Promise<boolean>; revoke: () => void };
const turns = new WeakMap<ProviderRuntimeWriter, Turn>();

/** В инструмент передаётся только запрос согласия, не функция принятия решения. */
export function deliveryConfirmationFor(writer: ProviderRuntimeWriter, isCurrent: () => boolean, expiresAt: number): ConfirmDelivery {
  const turn = turns.get(writer);
  return (...args) => turn?.confirm(isCurrent, expiresAt, ...args) ?? Promise.resolve(false);
}

export function revokeDeliveryApproval(writer: ProviderRuntimeWriter) {
  turns.get(writer)?.revoke();
}

/** Создаётся только при authenticated upgrade. Нет общего реестра/resolver по requestId. */
export function authenticatedDeliveryChannel(ws: WebSocket, userId: string | number | null) {
  type Prompt = { requestId: string; toolName: string; sessionId: string; input: { destinationPreview: string; names: string[] } };
  type Pending = { prompt: Prompt; finish: (allow: boolean) => void };
  const pending = new Map<string, Pending>(); // только этот сокет, ключ — app session
  let closed = false;
  const open = () => !closed && ws.readyState === 1;
  const send = (frame: object) => ws.send(JSON.stringify({ ...frame, provider: 'claude', timestamp: new Date().toISOString() }));

  return {
    bind(writer: ProviderRuntimeWriter, sessionId: string, isRunning: () => boolean) {
      if (userId == null || writer.userId !== userId || !open() || turns.has(writer)) return;
      let spent = false;
      let cancel: (() => void) | undefined;
      const turn: Turn = {
        async confirm(isCurrent, grantExpiry, destinationPreview, names, signal) {
          if (spent) return false;
          spent = true;
          const expiry = Math.min(Date.now() + APPROVAL_TTL_MS, grantExpiry);
          const current = () => turns.get(writer) === turn && open() && isRunning() && isCurrent()
            && !signal.aborted && Date.now() < expiry;
          // Не исправлять/усекать адрес. Невидимые управляющие и bidi-символы
          // сделали бы фактический путь отличным от видимого на карточке.
          if (!current() || pending.has(sessionId) || !destinationPreview.trim() || destinationPreview.length > 8192
            || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(destinationPreview) || !names.length || names.length > PROTECTED_DATA_MAX_FIELDS
            || !names.every(isProtectedDataAlias) || new Set(names).size !== names.length) return false;
          const prompt = { requestId: `delivery-${randomUUID()}`, sessionId, toolName: TOOL, input: { destinationPreview, names: [...names] } };
          const allowed = await new Promise<boolean>(resolve => {
            const finish = (allow: boolean) => {
              if (pending.get(sessionId)?.prompt !== prompt) return;
              pending.delete(sessionId);
              cancel = undefined;
              clearTimeout(timer);
              signal.removeEventListener('abort', abort);
              resolve(allow && current());
              try { if (open()) send({ kind: 'permission_resolved', sessionId, requestId: prompt.requestId }); } catch { /* сокет уже закрыт */ }
            };
            const abort = () => finish(false);
            const timer = setTimeout(abort, expiry - Date.now());
            timer.unref();
            cancel = abort;
            signal.addEventListener('abort', abort, { once: true });
            pending.set(sessionId, { prompt, finish }); // до публикации, вне writer/replay
            try { send({ kind: 'permission_request', ...prompt }); } catch { abort(); }
          });
          return allowed && current();
        },
        revoke() { turns.delete(writer); cancel?.(); },
      };
      turns.set(writer, turn);
    },
    pendingFor(sessionId: string) {
      const entry = pending.get(sessionId);
      return entry ? [entry.prompt] : [];
    },
    receive(data: Record<string, unknown>, sessionExists: boolean) {
      if (!open() || !sessionExists || data.type !== DECISION || typeof data.sessionId !== 'string' || typeof data.allow !== 'boolean'
        || Object.keys(data).some(k => !['type', 'requestId', 'sessionId', 'allow'].includes(k))) return;
      const entry = pending.get(data.sessionId);
      if (entry && data.requestId === entry.prompt.requestId) entry.finish(data.allow);
    },
    close() {
      closed = true;
      for (const entry of pending.values()) entry.finish(false);
    },
  };
}
