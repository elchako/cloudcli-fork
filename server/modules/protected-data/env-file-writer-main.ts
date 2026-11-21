import { writeProtectedEnvEntry } from './env-file-writer.js';
import { PROTECTED_DATA_MAX_VALUE_BYTES } from './protocol.js';

// Аргументы задаёт владелец установки. Значение приходит только по stdin;
// ни успех, ни отказ не печатают содержимое файла или значения.
const chunks: Buffer[] = [];
let raw: Buffer | undefined;
try {
  const [file, name] = process.argv.slice(2);
  if (!file || !name || process.argv.length !== 4) throw new Error('Недопустимые аргументы');
  let size = 0;
  for await (const chunk of process.stdin) {
    if (!Buffer.isBuffer(chunk) || (size += chunk.length) > PROTECTED_DATA_MAX_VALUE_BYTES) throw new Error('Недопустимый ввод');
    chunks.push(chunk);
  }
  raw = Buffer.concat(chunks);
  await writeProtectedEnvEntry(file, name, new TextDecoder('utf-8', { fatal: true }).decode(raw));
} catch {
  process.exitCode = 1;
} finally {
  raw?.fill(0);
  for (const chunk of chunks) chunk.fill(0);
}
