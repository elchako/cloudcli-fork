#!/usr/bin/env node
// GOLDJAXE fork (реестр §23): только явный административный запуск, не из runtime.
import { generateKeyPairSync } from 'node:crypto';
import { closeSync, constants, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const [privateFlag, privatePath, publicFlag, publicPath, ...extra] = process.argv.slice(2);
if (privateFlag !== '--private-key' || publicFlag !== '--public-key' || !privatePath || !publicPath
  || !isAbsolute(privatePath) || !isAbsolute(publicPath) || privatePath === publicPath || extra.length) {
  console.error('Использование: node scripts/mail-approval-keygen.mjs --private-key /absolute/private.pem --public-key /absolute/public.json');
  process.exitCode = 1;
} else {
  let privateFd;
  let publicFd;
  let complete = false;
  try {
    // O_EXCL: не перезаписываем существующий ключ и не следуем symlink.
    privateFd = openSync(privatePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    publicFd = openSync(publicPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    writeFileSync(privateFd, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    writeFileSync(publicFd, `${JSON.stringify({ key_id: 'cloudcli-local-human', public_key: spki.subarray(-32).toString('base64url') }, null, 2)}\n`);
    complete = true;
    console.log('Ключ и открытая часть созданы. Локальное подтверждение не включено автоматически.');
  } catch {
    console.error('Не удалось создать ключ. Нужны новые абсолютные пути в защищённом административном каталоге.');
    process.exitCode = 1;
  } finally {
    if (privateFd !== undefined) { closeSync(privateFd); if (!complete) unlinkSync(privatePath); }
    if (publicFd !== undefined) { closeSync(publicFd); if (!complete) unlinkSync(publicPath); }
  }
}
