import { isAbsolute } from 'node:path';

import { writeProtectedEnvEntries, writeProtectedEnvEntry } from './env-file-writer.js';
import { PROTECTED_DATA_MAX_BODY_BYTES, PROTECTED_DATA_MAX_FIELDS, PROTECTED_DATA_MAX_VALUE_BYTES } from './protocol.js';

function readPairs(text: string): Map<string, string> {
  const pairs: unknown = JSON.parse(text);
  if (!Array.isArray(pairs) || !pairs.length || pairs.length > PROTECTED_DATA_MAX_FIELDS) throw new Error('Недопустимый набор');
  const fields = new Map<string, string>();
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2) throw new Error('Недопустимая пара');
    const [name, value] = pair;
    if (typeof name !== 'string' || typeof value !== 'string' || fields.has(name)) throw new Error('Недопустимое поле');
    fields.set(name, value);
  }
  return fields;
}

// GOLDJAXE fork (реестр §27.3): путь закреплён владельцем, не берётся из stdin или SSH_ORIGINAL_COMMAND.
// Без имени поля принимаем JSON-пары, с именем — одно значение как раньше. Вывод всегда пуст.
const chunks: Buffer[] = [];
let raw: Buffer | undefined;
try {
  const [file, name, ...extra] = process.argv.slice(2);
  if (!file || !isAbsolute(file) || name === '' || extra.length) throw new Error('Недопустимые аргументы');
  const limit = name === undefined ? PROTECTED_DATA_MAX_BODY_BYTES : PROTECTED_DATA_MAX_VALUE_BYTES;
  let size = 0;
  for await (const chunk of process.stdin) {
    if (!Buffer.isBuffer(chunk)) throw new Error('Недопустимый ввод');
    chunks.push(chunk);
    if ((size += chunk.length) > limit) throw new Error('Недопустимый ввод');
  }
  raw = Buffer.concat(chunks);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  if (name === undefined) await writeProtectedEnvEntries(file, readPairs(text));
  else await writeProtectedEnvEntry(file, name, text);
} catch {
  process.exitCode = 1;
} finally {
  raw?.fill(0);
  for (const chunk of chunks) chunk.fill(0);
}
