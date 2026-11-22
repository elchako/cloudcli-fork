import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { homedir } from 'node:os';

import { isProtectedDataAlias, PROTECTED_DATA_MAX_FIELDS, PROTECTED_DATA_MAX_VALUE_BYTES } from './protocol.js';
import { SSH_ENV_COMMAND } from './ssh-env-writer.js';

type Destination = { host: string; user?: string; port?: number; path: string };
const denied = () => new Error('Доставка по SSH не подтверждена');
const TIMEOUT_MS = 10_000;

// GOLDJAXE fork (реестр §27.5): shell только для доверенного keychain, до передачи
// данных. --query не запускает фонового агента, --env не читает пользовательский rc.
// Уже заведённый оператором агент и закреплённый host key обязательны.
const GET_AGENT = `set -eu
vars=$(/usr/bin/keychain --eval --quiet --query --agents ssh --noask --nogui --nolock --env /dev/null 2>/dev/null)
eval "$vars"
test -S "$SSH_AUTH_SOCK"
printf '%s' "$SSH_AUTH_SOCK"`;

function sshArgs({ host, user, port = 22 }: Destination): string[] {
  if (typeof host !== 'string' || (!/^[A-Za-z0-9_][\w.-]{0,252}$/u.test(host) && !(/^[0-9a-f:.]+$/iu.test(host) && isIP(host) === 6))
    || (user !== undefined && (typeof user !== 'string' || !/^[A-Za-z_][\w.-]{0,63}$/u.test(user)))
    || !Number.isInteger(port) || port < 1 || port > 65535) throw denied();
  return ['-F', '/dev/null', '-T', '-a', '-x', '-S', 'none', '-p', String(port),
    '-oBatchMode=yes', '-oStrictHostKeyChecking=yes', '-oUpdateHostKeys=no',
    '-oClearAllForwardings=yes', '-oControlMaster=no', '-oControlPersist=no', '-oPermitLocalCommand=no',
    '-oPreferredAuthentications=publickey', '-oIdentityFile=none', '-oAddKeysToAgent=no',
    '-oUserKnownHostsFile=${HOME}/.ssh/known_hosts ${HOME}/.ssh/known_hosts2', '-oConnectionAttempts=1',
    ...(user === undefined ? [] : ['-l', user]), '--', host, SSH_ENV_COMMAND];
}

function encode(nonce: string, path: string, fields: ReadonlyMap<string, string>): Buffer {
  if (typeof path !== 'string' || path.length > 4096 || !path.startsWith('/')) throw denied();
  const parts = path.slice(1).split('/');
  if (!parts.every(p => /^[\w.-]+$/u.test(p) && !['.', '..', '.git'].includes(p))
    || !/^(?:\.env(?:\.[\w.-]+)?|[\w.-]+\.env)$/u.test(parts.at(-1) ?? '')) throw denied();
  if (!fields.size || fields.size > PROTECTED_DATA_MAX_FIELDS) throw denied();
  const pairs: [string, string][] = [];
  for (const [key, value] of fields) {
    if (!isProtectedDataAlias(key) || typeof value !== 'string' || !value || value.length > PROTECTED_DATA_MAX_VALUE_BYTES
      || /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF﻿\p{Noncharacter_Code_Point}]/u.test(value)
      || Buffer.byteLength(value) > PROTECTED_DATA_MAX_VALUE_BYTES) throw denied();
    pairs.push([key, value]);
  }
  return Buffer.from(JSON.stringify([nonce, path, pairs]));
}

// Оба этапа имеют один дедлайн. Ждём close после убийства всей локальной группы,
// не возвращаем диагностику, не накапливаем произвольный stdout удалённой оболочки.
function run(file: string, args: string[], env: NodeJS.ProcessEnv, input: Buffer | undefined, max: number, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: '/', env, detached: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
    const output = Buffer.alloc(max);
    let size = 0; let failed = false; let flushed = false;
    const stop = () => {
      failed = true;
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Процесс уже завершился. */ }
      }
      child.stdin.destroy();
    };
    signal.addEventListener('abort', stop, { once: true });
    child.on('error', stop);
    child.stdin.on('error', stop);
    child.stdout.on('error', stop);
    child.stdout.on('data', (part: Buffer) => {
      if (part.length > max - size) stop();
      else { part.copy(output, size); size += part.length; }
      part.fill(0);
    });
    child.once('close', code => {
      signal.removeEventListener('abort', stop);
      if (code === 0 && !failed && flushed && !signal.aborted) resolve(output.subarray(0, size));
      else { output.fill(0); reject(denied()); }
    });
    child.stdin.end(input, () => { flushed = true; });
  });
}

/** Назначение и состав набора уже подтверждены владельцем. Повторов нет: после
 * разрыва соединения запись могла завершиться без получения квитанции. */
export async function deliverSshEnv(destination: Destination, fields: ReadonlyMap<string, string>, signal: AbortSignal): Promise<void> {
  let input: Buffer | undefined;
  try {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
    deadline.throwIfAborted();
    const args = sshArgs(destination);
    const nonce = randomBytes(32).toString('hex');
    input = encode(nonce, destination.path, fields);
    const env = { HOME: homedir(), PATH: '/usr/bin:/bin', SHELL: '/bin/sh' };
    const sock = await run('/bin/sh', ['-c', GET_AGENT], env, undefined, 4096, deadline);
    const expected = Buffer.from(nonce + '\n');
    const receipt = await run('/usr/bin/ssh', args, { ...env, SSH_AUTH_SOCK: sock.toString('utf8') }, input, expected.length, deadline);
    const confirmed = receipt.equals(expected);
    receipt.fill(0);
    if (!confirmed) throw denied();
  } catch { throw denied(); } finally { input?.fill(0); }
}
