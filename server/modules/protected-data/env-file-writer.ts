import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { PROTECTED_DATA_MAX_VALUE_BYTES, isProtectedDataAlias } from './protocol.js';

const MAX_FILE_BYTES = 64 * 1024;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const ASSIGNMENT = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)$/u;
const SINGLE_LINE_QUOTED = /^(?:'[^']*'|"(?:[^"\\]|\\.)*")[ \t]*$/u;
const invalid = () => new Error('Защищённая запись EnvironmentFile отклонена');

// GOLDJAXE fork (реестр §27.3): только плоские systemd EnvironmentFile.
// Многострочный или неоднозначный синтаксис отклоняется до любой записи.
export function updateEnvText(text: string, name: string, value: string): string {
  if (!isProtectedDataAlias(name) || !value || CONTROL.test(value)
    || Buffer.byteLength(value) > PROTECTED_DATA_MAX_VALUE_BYTES || text.includes('\0')) throw invalid();
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text ? text.split(eol) : [];
  const assignment = `${name}="${value.replace(/["\\`$]/g, '\\$&')}"`;
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/[\r\n]/.test(line)) throw invalid();
    if (/^[ \t]*(?:[;#]|$)/.test(line)) continue;
    const existing = ASSIGNMENT.exec(line);
    if (!existing) throw invalid();
    const [, key, body] = existing;
    if (body.endsWith('\\') || (/^["']/.test(body) && !SINGLE_LINE_QUOTED.test(body))) throw invalid();
    if (key !== name) continue;
    if (found) throw invalid();
    lines[i] = assignment;
    found = true;
  }
  if (found) return lines.join(eol);
  if (lines.at(-1) === '') lines.pop();
  return [...lines, assignment, ''].join(eol);
}

export async function writeProtectedEnvEntry(path: string, name: string, value: string): Promise<void> {
  const uid = process.geteuid?.();
  if (uid === undefined || resolve(path) !== path || await realpath(path) !== path) throw invalid();
  const dir = dirname(path);
  const dirStat = await lstat(dir);
  if (!dirStat.isDirectory() || (dirStat.uid !== uid && dirStat.uid !== 0) || (dirStat.mode & 0o022) !== 0) throw invalid();

  const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let stat;
  let updated;
  try {
    stat = await source.stat();
    if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES
      || ![0o600, 0o640].includes(stat.mode & 0o7777)) throw invalid();
    const bytes = Buffer.alloc(stat.size + 1);
    try {
      const { bytesRead } = await source.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== stat.size) throw invalid();
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, bytesRead));
      updated = Buffer.from(updateEnvText(text, name, value));
      if (updated.length > MAX_FILE_BYTES) { updated.fill(0); throw invalid(); }
    } finally { bytes.fill(0); }
  } finally { await source.close(); }

  const temp = join(dir, `.cloudcli-env-${randomUUID()}.tmp`);
  let created = false;
  try {
    const output = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    created = true;
    try {
      await output.writeFile(updated);
      if ((await output.stat()).gid !== stat.gid) await output.chown(stat.uid, stat.gid);
      await output.chmod(stat.mode & 0o777);
      await output.sync();
    } finally { await output.close(); }
    const current = await lstat(path);
    if (current.dev !== stat.dev || current.ino !== stat.ino || current.ctimeMs !== stat.ctimeMs || current.size !== stat.size) throw invalid();
    await rename(temp, path);
    created = false;
  } finally {
    updated.fill(0);
    if (created) await unlink(temp);
  }
}
