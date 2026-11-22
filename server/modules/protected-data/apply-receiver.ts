import { spawn } from 'node:child_process';
import { accessSync, closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';

import { isProtectedDataAlias, isProtectedDataLabel, isProtectedDataTargetId } from './protocol.js';

type ReceiverCommand = { label: string; executable: string; args: string[] };
export type ApplyReceiver = ReceiverCommand & { field: string };
export type NamedApplyReceiver = ReceiverCommand & { id: string };
export type ApplyConfig = ApplyReceiver | { targets: NamedApplyReceiver[] };

export const PROJECT_ENV_ID = 'project-env';
export const DELIVERY_CHECK_ID = 'delivery-check';
const COMMAND_FIELDS = ['label', 'executable', 'args'];
const CONTROL = /[\u0000-\u001f\u007f]/u;
const invalid = () => new Error('Недопустимая конфигурация применения защищённых данных');

function hasOnlyFields(value: unknown, fields: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => fields.includes(key));
}

function readCommand({ label, executable, args }: Record<string, unknown>): ReceiverCommand {
  if (!isProtectedDataLabel(label) || typeof executable !== 'string'
    || !isAbsolute(executable) || CONTROL.test(executable) || !Array.isArray(args) || args.length > 16
    || !args.every((arg): arg is string => typeof arg === 'string' && arg.length <= 4096 && !CONTROL.test(arg))) throw invalid();
  const file = realpathSync(executable);
  const stat = statSync(file);
  if (!stat.isFile() || (stat.mode & 0o6022) !== 0 || (stat.uid !== 0 && stat.uid !== process.geteuid?.())) throw invalid();
  accessSync(file, constants.X_OK);
  return { label, executable: file, args: [...args] };
}

// GOLDJAXE fork (реестр §27.3–27.4): команду и аргументы закрепляет оператор, не модель.
// Для SSH рекомендуется отдельный ключ с forced-command у получателя.
export function readApplyReceiver(path: string | undefined): ApplyConfig | undefined {
  if (path === undefined) return undefined;
  if (!isAbsolute(path) || CONTROL.test(path)) throw invalid();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let raw: unknown;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16 * 1024 || stat.uid !== process.geteuid?.() || (stat.mode & 0o077) !== 0) throw invalid();
    raw = JSON.parse(readFileSync(fd, 'utf8')) as unknown;
  } finally { closeSync(fd); }
  if (hasOnlyFields(raw, ['targets'])) {
    if (!Array.isArray(raw.targets) || raw.targets.length < 1 || raw.targets.length > 16) throw invalid();
    const ids = new Set<string>([PROJECT_ENV_ID, DELIVERY_CHECK_ID]);
    const targets = raw.targets.map((target: unknown) => {
      if (!hasOnlyFields(target, [...COMMAND_FIELDS, 'id']) || !isProtectedDataTargetId(target.id) || ids.has(target.id)) throw invalid();
      ids.add(target.id);
      return { id: target.id, ...readCommand(target) };
    });
    return { targets };
  }
  if (!hasOnlyFields(raw, [...COMMAND_FIELDS, 'field']) || !isProtectedDataAlias(raw.field)) throw invalid();
  return { field: raw.field, ...readCommand(raw) };
}

export function applyToReceiver(receiver: ReceiverCommand, value: string, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  const input = Buffer.from(value, 'utf8');
  return new Promise((resolve) => {
    try {
      const child = spawn(receiver.executable, receiver.args, {
        cwd: '/', env: { HOME: homedir(), PATH: '/usr/bin:/bin' }, shell: false,
        stdio: ['pipe', 'ignore', 'ignore'], signal, killSignal: 'SIGKILL',
      });
      let failed = false;
      let flushed = false;
      child.stdin.on('error', () => { failed = true; });
      child.on('error', () => { failed = true; });
      child.once('close', (code) => {
        input.fill(0);
        resolve(!failed && flushed && !signal.aborted && code === 0);
      });
      child.stdin.end(input, () => { flushed = true; input.fill(0); });
    } catch {
      input.fill(0);
      resolve(false);
    }
  });
}
