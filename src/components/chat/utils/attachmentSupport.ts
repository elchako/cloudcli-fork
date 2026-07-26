/**
 * Client-side gate for chat attachments. Mirrors the server allowlist
 * (`image-assets.service.ts`): images plus common document/text/code files.
 * Delivery for non-images is path-based (the agent reads the file), so the
 * list is about "safe to upload", not "a vision model can decode it".
 *
 * The server re-validates every upload; this is just early UX feedback.
 */

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20MB
export const MAX_ATTACHMENTS = 5;

const ALLOWED_DOCUMENT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.log', '.csv', '.tsv', '.json', '.ndjson',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env', '.xml', '.html',
  '.htm', '.pdf', '.rtf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.odt', '.ods', '.zip', '.gz', '.tar',
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs',
  '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.sh', '.bash',
  '.sql', '.css', '.scss', '.less', '.vue', '.svelte', '.astro', '.dart',
  '.swift', '.lua', '.pl', '.r', '.jl', '.tf', '.dockerfile', '.gitignore',
]);

/** True for image attachments (previewable inline). */
export function isImageFile(file: File): boolean {
  return !!file.type && file.type.startsWith('image/');
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

/** True when a file may be attached (image or allowed document). */
export function isSupportedAttachment(file: File): boolean {
  if (isImageFile(file)) {
    return true;
  }
  if (file.type && file.type.startsWith('text/')) {
    return true;
  }
  return ALLOWED_DOCUMENT_EXTENSIONS.has(extensionOf(file.name || ''));
}

/** Dropzone `accept` map: images by mime, documents by extension. */
export function dropzoneAccept(): Record<string, string[]> {
  return {
    'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'],
    'application/octet-stream': Array.from(ALLOWED_DOCUMENT_EXTENSIONS),
  };
}
