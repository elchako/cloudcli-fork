import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Serves media files an agent produced outside any project root — screenshots in
 * /tmp, downloads, and similar. The project file endpoints deliberately refuse
 * anything above the project root (PATH_OUTSIDE_PROJECT), which left such files
 * unviewable in the UI even though the chat happily linked to them.
 *
 * Access is confined to an allowlist of directories and to media extensions the
 * browser can render, so this never becomes a general "read any file" endpoint.
 */

// Media the browser renders natively. Keep in sync with the client's
// `src/components/code-editor/utils/previewableFile.ts`.
const MEDIA_MIME: Record<string, string> = {
  // Images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  avif: 'image/avif',
  apng: 'image/apng',
  // PDF
  pdf: 'application/pdf',
  // Video
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  // Audio
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  opus: 'audio/opus',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  weba: 'audio/webm',
};

export type LocalMediaResult =
  | { status: 'ok'; stream: fs.ReadStream; contentType: string; size: number }
  | { status: 'invalid' }
  | { status: 'forbidden' }
  | { status: 'missing' };

/**
 * Directories readable through this endpoint. Defaults cover where agents drop
 * generated media; override with CLOUDCLI_MEDIA_DIRS (OS path separator) when a
 * deployment keeps them elsewhere.
 */
export function getAllowedMediaRoots(): string[] {
  const configured = process.env.CLOUDCLI_MEDIA_DIRS;
  const raw = configured
    ? configured.split(path.delimiter)
    : [os.tmpdir(), path.join(os.homedir(), 'Downloads'), path.join(os.homedir(), '.cloudcli')];

  return raw
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(entry));
}

function isInsideAllowedRoot(resolvedPath: string): boolean {
  return getAllowedMediaRoots().some(
    (root) => resolvedPath === root || resolvedPath.startsWith(root + path.sep),
  );
}

export function getMediaContentType(filePath: string): string | null {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  return MEDIA_MIME[extension] ?? null;
}

/**
 * Opens a media file by absolute path, enforcing the allowlist.
 *
 * Symlinks are resolved before the boundary check (realpath), so a link planted
 * inside an allowed directory cannot reach outside it.
 */
export async function openLocalMedia(requestedPath: string): Promise<LocalMediaResult> {
  if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
    return { status: 'invalid' };
  }
  // A NUL byte truncates the path inside some syscalls — reject outright.
  if (requestedPath.includes('\0') || !path.isAbsolute(requestedPath)) {
    return { status: 'invalid' };
  }

  const contentType = getMediaContentType(requestedPath);
  if (!contentType) {
    return { status: 'forbidden' };
  }

  let realPath: string;
  try {
    realPath = await fsp.realpath(path.resolve(requestedPath));
  } catch {
    return { status: 'missing' };
  }

  if (!isInsideAllowedRoot(realPath)) {
    return { status: 'forbidden' };
  }

  let stats: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    stats = await fsp.stat(realPath);
  } catch {
    return { status: 'missing' };
  }
  if (!stats.isFile()) {
    return { status: 'missing' };
  }

  return {
    status: 'ok',
    stream: fs.createReadStream(realPath),
    contentType,
    size: stats.size,
  };
}
