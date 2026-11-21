import { spawn } from 'node:child_process';
import { accessSync, closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';

import { isProtectedDataAlias, isProtectedDataLabel } from './protocol.js';

export type ApplyReceiver = {
  label: string;
  field: string;
  executable: string;
  args: string[];
};

const FIELDS = ['label', 'field', 'executable', 'args'];
const CONTROL = /[\u0000-\u001f\u007f]/u;

// GOLDJAXE fork (реестр §27.3): получатель закрепляется настройкой владельца,
// не выбирается моделью, текстом задания или параметрами MCP.
export function readApplyReceiver(path: string | undefined): ApplyReceiver | undefined {
  if (path === undefined) return undefined;
  const invalid = () => new Error('Недопустимая конфигурация применения защищённых данных');
  if (!isAbsolute(path) || CONTROL.test(path)) throw invalid();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let raw: unknown;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16 * 1024 || stat.uid !== process.geteuid?.() || (stat.mode & 0o077) !== 0) throw invalid();
    raw = JSON.parse(readFileSync(fd, 'utf8')) as unknown;
  } finally { closeSync(fd); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((key) => !FIELDS.includes(key))) throw invalid();
  const { label, field, executable, args } = raw as Record<string, unknown>;
  if (!isProtectedDataLabel(label) || !isProtectedDataAlias(field) || typeof executable !== 'string'
    || !isAbsolute(executable) || CONTROL.test(executable) || !Array.isArray(args) || args.length > 16
    || !args.every((arg): arg is string => typeof arg === 'string' && arg.length <= 4096 && !CONTROL.test(arg))) throw invalid();
  const file = realpathSync(executable);
  const stat = statSync(file);
  if (!stat.isFile() || (stat.mode & 0o6022) !== 0 || (stat.uid !== 0 && stat.uid !== process.geteuid?.())) throw invalid();
  accessSync(file, constants.X_OK);
  return { label, field, executable: file, args: [...args] };
}

export function applyToReceiver(receiver: ApplyReceiver, value: string, signal: AbortSignal): Promise<boolean> {
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
