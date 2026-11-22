import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

import { writeProtectedEnvEntries } from './env-file-writer.js';

const run = promisify(execFile);
const denied = () => new Error('Запись в .env проекта недоступна');

const PART = /^[a-zA-Z0-9_.-]+$/u;
export function isEnvDestinationPath(path: string, absolute: boolean): boolean {
  const parts = (absolute ? path.slice(1) : path).split('/');
  return path.startsWith('/') === absolute && parts.every(p => PART.test(p) && !['.', '..', '.git'].includes(p))
    && /^(?:\.env(?:\.[\w.-]+)?|[\w.-]+\.env)$/u.test(parts.at(-1) ?? '');
}

// GOLDJAXE fork (реестр §27.4): корень только из строки сеанса. Не открываем
// произвольный путь и не помещаем секрет в отслеживаемый/неигнорируемый файл.
export async function applyProjectEnv(root: string, fields: ReadonlyMap<string, string>, path = '.env', signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (!isEnvDestinationPath(path, false) || !isAbsolute(root) || await realpath(root) !== root) throw denied();
  for (const value of fields.values()) {
    // Общая однозначная запись между плоским dotenv и systemd EnvironmentFile.
    if (/[\\"`$\u0000-\u001f\u007f]/u.test(value)) throw denied();
  }
  const file = join(root, path);
  if (await realpath(file) !== file) throw denied();
  const git = (args: string[]) => run('/usr/bin/git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd: dirname(file), signal, env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    timeout: 1500, maxBuffer: 4096,
  });
  const { stdout } = await git(['rev-parse', '--show-toplevel']);
  if (stdout !== `${root}\n`) throw denied();
  // check-ignore по умолчанию исключает уже отслеживаемые пути из результата.
  await git(['check-ignore', '--quiet', '--', basename(file)]);
  await writeProtectedEnvEntries(file, fields, signal);
}
