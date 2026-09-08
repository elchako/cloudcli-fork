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

// Keep this list in sync with the server (image-assets.service.ts).
const ALLOWED_DOCUMENT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.log', '.csv', '.tsv', '.json', '.ndjson',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env', '.xml', '.html',
  '.htm', '.pdf', '.rtf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.odt', '.ods', '.zip', '.gz', '.tar',
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs',
  '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.sh', '.bash',
  '.sql', '.css', '.scss', '.less', '.vue', '.svelte', '.astro', '.dart',
  '.swift', '.lua', '.pl', '.r', '.jl', '.tf',
]);

// Extension-less / dotfile names matched by full basename. Mirrors the server.
const ALLOWED_DOCUMENT_FILENAMES = new Set([
  'dockerfile', '.gitignore', '.dockerignore', '.env', 'makefile', '.npmrc',
  '.editorconfig', '.prettierrc', '.eslintrc',
]);

/** True for image attachments (previewable inline). */
export function isImageFile(file: File): boolean {
  return !!file.type && file.type.startsWith('image/');
}

// Real filename extension: a dotfile like ".gitignore" has NO extension (the
// leading dot is part of the name), matching the server's path.extname.
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/** True when a file may be attached (image or allowed document). */
export function isSupportedAttachment(file: File): boolean {
  if (isImageFile(file)) {
    return true;
  }
  if (file.type && file.type.startsWith('text/')) {
    return true;
  }
  const name = (file.name || '').toLowerCase();
  if (ALLOWED_DOCUMENT_EXTENSIONS.has(extensionOf(name))) {
    return true;
  }
  return ALLOWED_DOCUMENT_FILENAMES.has(name);
}

/**
 * Dropzone `accept` map. react-dropzone accepts a file if its extension is
 * listed under ANY mime key, so grouping the document extensions under broad
 * mime families lets the native picker accept them by extension. Drag-drop and
 * the picker are both re-validated by `isSupportedAttachment` in onDrop, so this
 * map only affects which files the OS dialog greys out.
 */
export function dropzoneAccept(): Record<string, string[]> {
  const docExts = Array.from(ALLOWED_DOCUMENT_EXTENSIONS);
  return {
    'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'],
    'text/*': docExts,
    'application/*': docExts,
  };
}
