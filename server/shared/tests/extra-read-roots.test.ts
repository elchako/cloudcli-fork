import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

// The read-only roots are collected when the utils module is first imported,
// so CLOUDCLI_READ_ROOTS has to be set before that import runs. The fixture
// lives beside this file rather than under the temp directory, which is a
// read-only root on its own and would make the escape tests pass for the wrong
// reason.
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = await realpath(await mkdtemp(path.join(testDirectory, 'extra-read-roots-fixture-')));
const allowedRoot = path.join(fixtureRoot, 'allowed');
const outsideDirectory = path.join(fixtureRoot, 'outside');
await mkdir(path.join(allowedRoot, 'nested'), { recursive: true });
await mkdir(outsideDirectory);

const previousExtraReadRoots = process.env.CLOUDCLI_READ_ROOTS;
process.env.CLOUDCLI_READ_ROOTS = [allowedRoot, '', 'relative/ignored'].join(path.delimiter);

const { getExtraReadRoots, resolveReadOnlyRootPath } = await import('@/shared/utils.js');

after(async () => {
  if (previousExtraReadRoots === undefined) {
    delete process.env.CLOUDCLI_READ_ROOTS;
  } else {
    process.env.CLOUDCLI_READ_ROOTS = previousExtraReadRoots;
  }
  await rm(fixtureRoot, { recursive: true, force: true });
});

test('extra read roots keep only absolute entries, trimmed and normalized', () => {
  const first = path.join(fixtureRoot, 'first');
  const second = path.join(fixtureRoot, 'second');

  assert.deepEqual(
    getExtraReadRoots({ CLOUDCLI_READ_ROOTS: [` ${first} `, '', '  ', 'relative/dir', `${second}${path.sep}`].join(path.delimiter) }),
    [first, second],
  );
  assert.deepEqual(getExtraReadRoots({}), []);
});

test('a file under an extra read root resolves as readable', async () => {
  const filePath = path.join(allowedRoot, 'nested', 'report.md');
  await writeFile(filePath, '# report', 'utf8');

  assert.equal(await resolveReadOnlyRootPath(filePath), filePath);
  assert.equal(await resolveReadOnlyRootPath(allowedRoot), allowedRoot);
});

test('an extra read root does not open its siblings or a traversal out of it', async () => {
  await writeFile(path.join(outsideDirectory, 'secret.txt'), 'secret', 'utf8');

  assert.equal(await resolveReadOnlyRootPath(path.join(outsideDirectory, 'secret.txt')), null);
  assert.equal(await resolveReadOnlyRootPath(`${allowedRoot}/../outside/secret.txt`), null);
  // `allowed` must not match a sibling that merely shares the prefix.
  const prefixSibling = `${allowedRoot}-sibling`;
  await mkdir(prefixSibling);
  assert.equal(await resolveReadOnlyRootPath(prefixSibling), null);
});

test('a symlink planted under an extra read root cannot read outside it', async () => {
  await writeFile(path.join(outsideDirectory, 'linked.txt'), 'secret', 'utf8');
  const escapeLink = path.join(allowedRoot, 'escape');
  await symlink(outsideDirectory, escapeLink);

  assert.equal(await resolveReadOnlyRootPath(escapeLink), null);
  assert.equal(await resolveReadOnlyRootPath(path.join(escapeLink, 'linked.txt')), null);
});
