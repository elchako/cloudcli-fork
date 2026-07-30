import fsSync, { promises as fs } from 'node:fs';
import path from 'node:path';

import mime from 'mime-types';

import { getGlobalImageAssetsDir, toPosixPath } from '@/shared/image-attachments.js';

/**
 * Image mime types accepted for chat attachment uploads. SVG is allowed for
 * storage/preview even though some providers (Claude API) skip it at send time.
 */
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

/**
 * Non-image mime types accepted for chat attachment uploads (documents, text,
 * data, code). These are delivered to the agent as a file path it reads with
 * its own file-reading tool, not embedded as base64 — so the list is about what
 * is safe to store and hand over, not what a vision model can decode.
 * Executables/scripts with an active mime are intentionally excluded; harmless
 * text-like code files usually arrive as text/plain or an empty mime and pass
 * via the extension allowlist below.
 */
const ALLOWED_DOCUMENT_MIME_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/tab-separated-values',
  'text/html',
  'text/xml',
  'application/xml',
  'application/json',
  'application/x-ndjson',
  'application/x-yaml',
  'text/yaml',
  'application/rtf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/zip',
  'application/gzip',
  'application/x-tar',
]);

/**
 * Extensions accepted when the browser sends an empty or generic mime type
 * (common for source code, logs, config). Delivery is path-based (the agent
 * reads the file), so these are safe to store.
 */
const ALLOWED_DOCUMENT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.log', '.csv', '.tsv', '.json', '.ndjson',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env', '.xml', '.html',
  '.htm', '.pdf', '.rtf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.odt', '.ods', '.zip', '.gz', '.tar',
  // common code/text extensions (read as text by the agent)
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs',
  '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.sh', '.bash',
  '.sql', '.css', '.scss', '.less', '.vue', '.svelte', '.astro', '.dart',
  '.swift', '.lua', '.pl', '.r', '.jl', '.tf',
]);

/**
 * Extension-less or dotfile names matched by full basename (path.extname
 * returns '' for these, so an extension allowlist never catches them).
 */
const ALLOWED_DOCUMENT_FILENAMES = new Set([
  'dockerfile', '.gitignore', '.dockerignore', '.env', 'makefile', '.npmrc',
  '.editorconfig', '.prettierrc', '.eslintrc',
]);

// Used only by this service and the assets routes via the barrel file.
type StoredImageAsset = {
  /** Original upload filename, for display. */
  name: string;
  /** Absolute posix-normalized path inside the global assets folder. */
  path: string;
  size: number;
  mimeType: string;
  /** 'image' → previewable/vision; 'document' → delivered as a readable path. */
  kind: 'image' | 'document';
};

// Shape of one multer-stored file; kept local because only this module reads it.
type UploadedImageFile = {
  originalname: string;
  filename: string;
  size: number;
  mimetype: string;
};

type UploadedAttachmentFile = UploadedImageFile;

/** Returns whether one uploaded mime type may be stored as a chat image asset. */
export function isAllowedImageMimeType(mimeType: string): boolean {
  return ALLOWED_IMAGE_MIME_TYPES.has(mimeType);
}

/**
 * Returns whether one uploaded file may be stored as a non-image document
 * attachment. Accepts by mime type, or — when the browser sends no/generic mime
 * — by a safe file extension. Path-based delivery means the agent reads the
 * file with its own tool; no base64 embedding.
 */
export function isAllowedDocumentUpload(mimeType: string, originalName: string): boolean {
  if (mimeType && ALLOWED_DOCUMENT_MIME_TYPES.has(mimeType)) {
    return true;
  }
  const name = (originalName || '').toLowerCase();
  const ext = path.extname(name);
  if (ext && ALLOWED_DOCUMENT_EXTENSIONS.has(ext)) {
    return true;
  }
  // Extension-less or dotfile config/text files (path.extname returns '' for
  // "Dockerfile" and ".gitignore"): match the whole basename.
  if (ALLOWED_DOCUMENT_FILENAMES.has(path.basename(name))) {
    return true;
  }
  // Generic/empty mime with a text-like family (e.g. "text/x-python").
  if (mimeType.startsWith('text/')) {
    return true;
  }
  return false;
}

/**
 * Returns whether one uploaded file is an acceptable chat attachment of any
 * kind (image or document).
 */
export function isAllowedAttachmentUpload(mimeType: string, originalName: string): boolean {
  return isAllowedImageMimeType(mimeType) || isAllowedDocumentUpload(mimeType, originalName);
}

/** Classifies a stored attachment for the UI and provider delivery. */
export function classifyAttachmentKind(mimeType: string): 'image' | 'document' {
  return isAllowedImageMimeType(mimeType) ? 'image' : 'document';
}

/** Creates the global `~/.cloudcli/assets` folder if needed and returns it. */
export async function ensureImageAssetsDir(): Promise<string> {
  const assetsDir = getGlobalImageAssetsDir();
  await fs.mkdir(assetsDir, { recursive: true });
  return assetsDir;
}

/**
 * Maps multer-stored upload files to the attachment records returned to the
 * chat composer. The absolute path is what providers receive and what session
 * history carries back to the UI.
 */
export function buildStoredImageRecords(files: UploadedImageFile[]): StoredImageAsset[] {
  const assetsDir = getGlobalImageAssetsDir();
  return files.map((file) => ({
    name: file.originalname,
    path: toPosixPath(path.join(assetsDir, file.filename)),
    size: file.size,
    mimeType: file.mimetype,
    kind: classifyAttachmentKind(file.mimetype),
  }));
}

/**
 * Maps multer-stored files to provider-neutral attachment records for the
 * assets route. The shared storage format intentionally matches image records
 * so one uploaded file can move through queueing and provider dispatch.
 */
export function buildStoredAttachmentRecords(files: UploadedAttachmentFile[]): StoredImageAsset[] {
  return buildStoredImageRecords(files);
}

/**
 * Resolves one asset filename to its absolute path inside the global assets
 * folder, or null when the name is empty, contains path separators/traversal,
 * or would escape the folder. This is the only lookup the serving route uses,
 * so nothing outside `~/.cloudcli/assets` can ever be read through it.
 */
export function resolveImageAssetFile(filename: string): string | null {
  const trimmed = typeof filename === 'string' ? filename.trim() : '';
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    return null;
  }

  const assetsDir = path.resolve(getGlobalImageAssetsDir());
  const resolved = path.resolve(assetsDir, trimmed);
  if (!resolved.startsWith(assetsDir + path.sep)) {
    return null;
  }

  return resolved;
}

/**
 * Resolves a general chat attachment for the assets serving route. It shares
 * the image resolver's strict direct-child containment boundary.
 */
export function resolveAttachmentAssetFile(filename: string): string | null {
  return resolveImageAssetFile(filename);
}

/**
 * Opens one stored chat asset for the assets route without exposing arbitrary
 * filesystem reads. The route translates the lookup status and streams the
 * returned direct-child file to the authenticated client.
 */
export async function openStoredAttachmentAsset(filename: string) {
  const resolved = resolveAttachmentAssetFile(filename);
  if (!resolved) {
    return { status: 'invalid' as const };
  }

  try {
    await fs.access(resolved);
  } catch {
    return { status: 'missing' as const };
  }

  return {
    status: 'found' as const,
    contentType: mime.lookup(resolved) || 'application/octet-stream',
    stream: fsSync.createReadStream(resolved),
  };
}
