import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { PROTECTED_DATA_MAX_FIELDS, PROTECTED_DATA_MAX_VALUE_BYTES, isProtectedDataAlias } from './protocol.js';

const MAX_FILE_BYTES = 64 * 1024;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const ASSIGNMENT = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)$/u;
const SINGLE_LINE_QUOTED = /^(?:'[^']*'|"(?:[^"\\]|\\.)*")[ \t]*$/u;
const invalid = () => new Error('Защищённая запись EnvironmentFile отклонена');

function prepareAssignments(fields: ReadonlyMap<string, string>): Map<string, string> {
  if (!fields.size || fields.size > PROTECTED_DATA_MAX_FIELDS) throw invalid();
  const assignments = new Map<string, string>();
  for (const [name, value] of fields) {
    if (!isProtectedDataAlias(name) || typeof value !== 'string' || !value || CONTROL.test(value)
      || /[\uD800-\uDFFF]/u.test(value) || Buffer.byteLength(value) > PROTECTED_DATA_MAX_VALUE_BYTES) throw invalid();
    assignments.set(name, `${name}="${value.replace(/["\\`$]/g, '\\$&')}"`);
  }
  return assignments;
}

// GOLDJAXE fork (реестр §27.3): только плоские systemd EnvironmentFile.
// Многострочный или неоднозначный синтаксис отклоняется до любой записи.
function updateAssignments(text: string, assignments: ReadonlyMap<string, string>): string {
  if (text.includes('\0')) throw invalid();
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text ? text.split(eol) : [];
  const found = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/[\r\n]/.test(line)) throw invalid();
    if (/^[ \t]*(?:[;#]|$)/.test(line)) continue;
    const existing = ASSIGNMENT.exec(line);
    if (!existing) throw invalid();
    const [, key, body] = existing;
    if (body.endsWith('\\') || (/^["']/.test(body) && !SINGLE_LINE_QUOTED.test(body))) throw invalid();
    const assignment = assignments.get(key);
    if (assignment === undefined) continue;
    if (found.has(key)) throw invalid();
    lines[i] = assignment;
    found.add(key);
  }
  if (found.size < assignments.size) {
    if (lines.at(-1) === '') lines.pop();
    for (const [key, assignment] of assignments) if (!found.has(key)) lines.push(assignment);
    lines.push('');
  }
  return lines.join(eol);
}

export function updateEnvText(text: string, name: string, value: string): string {
  return updateAssignments(text, prepareAssignments(new Map([[name, value]])));
}

export function writeProtectedEnvEntry(path: string, name: string, value: string): Promise<void> {
  return writeProtectedEnvEntries(path, new Map([[name, value]]));
}

export async function writeProtectedEnvEntries(path: string, fields: ReadonlyMap<string, string>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const assignments = prepareAssignments(fields);
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
      updated = Buffer.from(updateAssignments(text, assignments));
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
    signal?.throwIfAborted();
    await rename(temp, path);
    created = false;
  } finally {
    updated.fill(0);
    if (created) await unlink(temp);
  }
}
