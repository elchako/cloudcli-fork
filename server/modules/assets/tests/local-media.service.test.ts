import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test, { after, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';

import { getAllowedMediaRoots, openLocalMedia } from '@/modules/assets/services/local-media.service.js';

// Beside this file, not under the temp directory: the temp directory is one of
// the default media roots and would let the "outside" file through.
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = await realpath(await mkdtemp(path.join(testDirectory, 'local-media-fixture-')));
const mediaRoot = path.join(fixtureRoot, 'media');
const readRoot = path.join(fixtureRoot, 'read');
const outsideDirectory = path.join(fixtureRoot, 'outside');
await Promise.all([mediaRoot, readRoot, outsideDirectory].map((directory) => mkdir(directory)));

const previousMediaDirs = process.env.CLOUDCLI_MEDIA_DIRS;
const previousExtraReadRoots = process.env.CLOUDCLI_READ_ROOTS;

beforeEach(() => {
  process.env.CLOUDCLI_MEDIA_DIRS = mediaRoot;
  process.env.CLOUDCLI_READ_ROOTS = readRoot;
});

after(async () => {
  for (const [name, value] of [['CLOUDCLI_MEDIA_DIRS', previousMediaDirs], ['CLOUDCLI_READ_ROOTS', previousExtraReadRoots]] as const) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  await rm(fixtureRoot, { recursive: true, force: true });
});

const expectServed = async (filePath: string) => {
  const media = await openLocalMedia(filePath);
  assert.equal(media.status, 'ok');
  if (media.status === 'ok') {
    assert.equal(media.contentType, 'image/png');
    media.stream.destroy();
  }
};

test('the file viewer read roots are media roots too', async () => {
  assert.deepEqual(getAllowedMediaRoots(), [mediaRoot, readRoot]);

  const shot = path.join(readRoot, 'shot.png');
  await writeFile(shot, 'png');
  await expectServed(shot);
});

test('the media directories still work alongside the read roots', async () => {
  const shot = path.join(mediaRoot, 'shot.png');
  await writeFile(shot, 'png');
  await expectServed(shot);
});

test('a read root serves media only, and nothing outside every root is served', async () => {
  const notes = path.join(readRoot, 'notes.txt');
  await writeFile(notes, 'text');
  assert.equal((await openLocalMedia(notes)).status, 'forbidden');

  const outsideShot = path.join(outsideDirectory, 'shot.png');
  await writeFile(outsideShot, 'png');
  assert.equal((await openLocalMedia(outsideShot)).status, 'forbidden');
});
