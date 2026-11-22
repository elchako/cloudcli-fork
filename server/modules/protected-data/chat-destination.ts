import { request } from 'node:https';
import { isIP } from 'node:net';
import { userInfo } from 'node:os';
import { join } from 'node:path';

import { applyProjectEnv, isEnvDestinationPath } from './project-env.js';
import type { ProtectedDataStatus } from './protocol.js';

// GOLDJAXE fork (реестр §27.5): это предложение для карточки владельца, а не разрешение.
// Одни и те же разобранные данные используются для показа и исполнения.
export type ChatDestination =
  | Readonly<{ kind: 'project'; path: string }>
  | Readonly<{ kind: 'ssh'; host: string; user?: string; port?: number; path: string }>
  | Readonly<{ kind: 'https'; url: string }>;

export type ConfirmDelivery = (preview: string, names: readonly string[], signal: AbortSignal) => Promise<boolean>;
// Только внутри процесса, никогда не поле HTTP/WS-конверта.
export type ConfirmedDelivery = Readonly<{ destination: ChatDestination; names: readonly string[]; signal: AbortSignal }>;

export function parseChatDestination(input: unknown): ChatDestination | null {
  if (typeof input !== 'string' || !input || input.length > 2048 || /[^\x21-\x7e]|[\\%?#]/u.test(input)) return null;
  if (input.startsWith('project:')) {
    const path = input.slice(8);
    return isEnvDestinationPath(path, false) ? { kind: 'project', path } : null;
  }
  if (input.startsWith('ssh://')) {
    // Не используем shell и не допускаем неявную нормализацию ../, %-escape или пароля в URI.
    const parts = /^ssh:\/\/(?:(?<user>[A-Za-z_][\w.-]{0,63})@)?(?<host>[A-Za-z0-9_][\w.-]{0,252}|\[[\da-fA-F:./]+\])(?::(?<port>[1-9]\d{0,4}))?(?<path>\/.*)$/u.exec(input)?.groups;
    if (!parts || !isEnvDestinationPath(parts.path, true)) return null;
    const host = parts.host.startsWith('[') ? parts.host.slice(1, -1) : parts.host;
    if (parts.host.startsWith('[') && isIP(host) !== 6) return null;
    const port = parts.port ? Number(parts.port) : undefined;
    if (port && port > 65535) return null;
    const user = parts.user || userInfo().username; // Явно показать даже системный логин по умолчанию.
    if (!/^[A-Za-z_][\w.-]{0,63}$/u.test(user)) return null;
    return { kind: 'ssh', host, user, ...(port ? { port } : {}), path: parts.path };
  }
  if (input.startsWith('https://')) {
    try {
      const url = new URL(input);
      // Только точный адрес, без пароля, токена запроса или неоднозначного пути.
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
          || /@/.test(input.split('/')[2]) || (input !== url.href && `${input}/` !== url.href)) return null;
      return { kind: 'https', url: url.href };
    } catch { return null; }
  }
  return null;
}

export function chatDestinationPreview(d: ChatDestination, projectRoot?: string): string | null {
  if (d.kind === 'project') return projectRoot ? `Локальный файл проекта: ${join(projectRoot, d.path)}` : null;
  if (d.kind === 'https') return `HTTPS POST · JSON с выбранными полями → ${d.url}`;
  const host = isIP(d.host) === 6 ? `[${d.host}]` : d.host;
  return `Файл окружения systemd на VPS: ssh://${d.user ? `${d.user}@` : ''}${host}:${d.port ?? 22}${d.path}`;
}

// HTTPS-получатель принимает именно JSON-объект. Ответ сервиса, Location и заголовки
// не входят в SDK. 2xx подтверждает доставку, не запись в конфигурацию сервиса.
function postFields(url: string, fields: ReadonlyMap<string, string>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(Object.fromEntries(fields)));
    const req = request(url, { method: 'POST', agent: false, rejectUnauthorized: true, signal,
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, res => {
      const ok = res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300;
      res.destroy();
      if (ok) resolve(); else reject(new Error('Доставка не подтверждена'));
    });
    req.once('close', () => body.fill(0));
    req.once('error', () => reject(new Error('Доставка не подтверждена')));
    req.end(body);
  });
}

export async function deliverConfirmed(d: ChatDestination, fields: ReadonlyMap<string, string>, projectRoot: string | undefined, signal: AbortSignal): Promise<ProtectedDataStatus> {
  signal.throwIfAborted();
  if (d.kind === 'https') { await postFields(d.url, fields, signal); return 'delivered'; }
  if (d.kind === 'ssh') {
    const { deliverSshEnv } = await import('./ssh-env-delivery.js');
    await deliverSshEnv(d, fields, signal);
  } else if (projectRoot) await applyProjectEnv(projectRoot, fields, d.path, signal);
  else return 'invalid';
  return 'applied';
}
