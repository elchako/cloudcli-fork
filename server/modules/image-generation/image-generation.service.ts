import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  getGlobalImageAssetsDir,
  isAllowedImageSourcePath,
  resolveImageAbsolutePath,
  resolveImageMediaType,
  toPosixPath,
} from '@/shared/image-attachments.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

/**
 * Image generation for chat runs, through the same gateway the Claude CLI already talks to
 * (`ANTHROPIC_BASE_URL`). The holding's CLIProxyAPI exposes OpenAI's image endpoints for
 * the ChatGPT subscription, so a picture needs no extra keys: the agent calls the
 * `generate_image` tool, the file lands in the global assets folder, and the chat renders
 * it through the authenticated `/api/assets/images/:filename` route.
 */

const DEFAULT_IMAGE_MODEL = 'gpt-image-2.5';

/** High-quality edits take well over a minute on the gateway; leave headroom. */
export const IMAGE_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

/** Upper bound for reference images in one edit call. */
export const MAX_INPUT_IMAGES = 10;

/** Mirrors the chat upload limit, so anything a user attached can be edited. */
const MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024;

/** Formats the images edit endpoint accepts as input. */
const EDITABLE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

const OUTPUT_EXTENSIONS: Record<string, string> = { png: 'png', jpeg: 'jpg', webp: 'webp' };

/** The gateway treats size as an aspect hint and picks the exact resolution itself. */
export const IMAGE_SIZES = ['1024x1024', '1536x1024', '1024x1536', 'auto'] as const;
export const IMAGE_QUALITIES = ['low', 'medium', 'high', 'auto'] as const;
export const IMAGE_BACKGROUNDS = ['opaque', 'transparent', 'auto'] as const;

export type ImageGenerationRequest = {
  prompt: string;
  size?: (typeof IMAGE_SIZES)[number];
  quality?: (typeof IMAGE_QUALITIES)[number];
  background?: (typeof IMAGE_BACKGROUNDS)[number];
  /** Existing images to edit or use as references; switches the call to the edits endpoint. */
  inputImages?: string[];
  /** Run working directory: relative input paths resolve against it and it bounds what may be sent. */
  cwd?: string;
};

export type GeneratedImage = {
  /** Absolute path of the saved file, a direct child of `~/.cloudcli/assets`. */
  filePath: string;
  /** Same-origin URL the chat renders through the authenticated assets route. */
  url: string;
  model: string;
  /** Resolution the gateway reports, e.g. "1254x1254". */
  size: string | null;
};

type ImageGateway = {
  baseUrl: string;
  token: string;
  model: string;
};

type InputImage = {
  name: string;
  mimeType: string;
  data: Buffer;
};

/**
 * Reads the `env` block of ~/.claude/settings.json — where the gateway is configured for the
 * Claude CLI (the systemd unit does not repeat it). Same source as the session-title service.
 */
async function loadClaudeSettingsEnv(): Promise<Record<string, unknown>> {
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    const settings = readObjectRecord(JSON.parse(await fs.readFile(settingsPath, 'utf8')));
    return readObjectRecord(settings?.env) ?? {};
  } catch {
    return {};
  }
}

/** True unless the operator explicitly turned image generation off. */
export function isImageGenerationEnabled(): boolean {
  const flag = process.env.CLOUDCLI_IMAGE_GEN?.trim().toLowerCase();
  return flag !== 'off' && flag !== '0' && flag !== 'false';
}

/**
 * Resolves the gateway for image calls, or null when there is none. Only an explicit
 * `ANTHROPIC_BASE_URL` counts: the public Anthropic API has no image endpoints, so without
 * a gateway the tool is not offered at all instead of failing on every call.
 */
export async function resolveImageGateway(): Promise<ImageGateway | null> {
  if (!isImageGenerationEnabled()) {
    return null;
  }

  const settingsEnv = await loadClaudeSettingsEnv();
  const read = (name: string): string | undefined =>
    process.env[name]?.trim() || readOptionalString(settingsEnv[name]);

  const baseUrl = read('ANTHROPIC_BASE_URL');
  const token = read('ANTHROPIC_API_KEY') || read('ANTHROPIC_AUTH_TOKEN');
  if (!baseUrl || !token) {
    return null;
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    token,
    model: read('CLOUDCLI_IMAGE_MODEL') || DEFAULT_IMAGE_MODEL,
  };
}

/**
 * Loads reference images for an edit call. Same trust boundary as chat attachments: only
 * files inside the run's working directory or the global assets folder may leave the
 * machine, and symlinks are resolved first so a planted link cannot reach outside.
 */
async function readInputImages(paths: string[], cwd: string | undefined): Promise<InputImage[]> {
  if (paths.length > MAX_INPUT_IMAGES) {
    throw new Error(`At most ${MAX_INPUT_IMAGES} input images are supported per call.`);
  }

  return Promise.all(paths.map(async (entry) => {
    const requested = entry.trim();
    let realPath: string;
    try {
      realPath = await fs.realpath(resolveImageAbsolutePath(cwd, requested));
    } catch {
      throw new Error(`Input image not found: ${requested}`);
    }

    if (!isAllowedImageSourcePath(realPath, cwd)) {
      throw new Error(`Input image must be inside the project or ~/.cloudcli/assets: ${requested}`);
    }

    const mimeType = resolveImageMediaType({ path: realPath });
    if (!mimeType || !EDITABLE_MEDIA_TYPES.has(mimeType)) {
      throw new Error(`Input image must be PNG, JPEG or WebP: ${requested}`);
    }

    const stats = await fs.stat(realPath);
    if (!stats.isFile() || stats.size > MAX_INPUT_IMAGE_BYTES) {
      throw new Error(`Input image must be a file under ${MAX_INPUT_IMAGE_BYTES / (1024 * 1024)} MB: ${requested}`);
    }

    return { name: path.basename(realPath), mimeType, data: await fs.readFile(realPath) };
  }));
}

/** Optional generation knobs, sent only when the agent chose them (the gateway defaults otherwise). */
function pickOptions(request: ImageGenerationRequest): Record<string, string> {
  const options: Record<string, string> = {};
  if (request.size) options.size = request.size;
  if (request.quality) options.quality = request.quality;
  if (request.background) options.background = request.background;
  return options;
}

async function postImageRequest(
  gateway: ImageGateway,
  prompt: string,
  request: ImageGenerationRequest,
  inputImages: InputImage[],
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { Authorization: `Bearer ${gateway.token}` };
  let endpoint: string;
  let body: string | FormData;

  if (inputImages.length > 0) {
    endpoint = '/v1/images/edits';
    const form = new FormData();
    form.append('model', gateway.model);
    form.append('prompt', prompt);
    for (const [key, value] of Object.entries(pickOptions(request))) {
      form.append(key, value);
    }
    for (const image of inputImages) {
      form.append('image[]', new Blob([new Uint8Array(image.data)], { type: image.mimeType }), image.name);
    }
    body = form;
  } else {
    endpoint = '/v1/images/generations';
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({ model: gateway.model, prompt, n: 1, ...pickOptions(request) });
  }

  const response = await fetch(`${gateway.baseUrl}${endpoint}`, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(IMAGE_REQUEST_TIMEOUT_MS),
  });

  const text = await response.text();
  let payload: Record<string, unknown> | null = null;
  try {
    payload = readObjectRecord(JSON.parse(text));
  } catch {
    // Not JSON: reported below with the raw text.
  }

  if (!response.ok) {
    const error = readObjectRecord(payload?.error);
    const message = readOptionalString(error?.message) || text.slice(0, 300) || response.statusText;
    throw new Error(`Image gateway returned ${response.status}: ${message}`);
  }
  if (!payload) {
    throw new Error('Image gateway returned a non-JSON response.');
  }
  return payload;
}

/**
 * Generates (or, with input images, edits) one image and stores it next to the chat
 * uploads. The file name keeps to `[0-9a-z.-]`, so the assets route serves it as a direct
 * child of the folder like any uploaded attachment.
 */
export async function generateImage(request: ImageGenerationRequest): Promise<GeneratedImage> {
  const gateway = await resolveImageGateway();
  if (!gateway) {
    throw new Error('Image generation is not available: no gateway configured (ANTHROPIC_BASE_URL + token) or CLOUDCLI_IMAGE_GEN=off.');
  }

  const prompt = request.prompt.trim();
  if (!prompt) {
    throw new Error('A prompt is required.');
  }

  const inputImages = await readInputImages(request.inputImages ?? [], request.cwd);
  const payload = await postImageRequest(gateway, prompt, request, inputImages);

  const firstImage = Array.isArray(payload.data) ? readObjectRecord(payload.data[0]) : null;
  const base64 = readOptionalString(firstImage?.b64_json);
  if (!base64) {
    throw new Error('Image gateway response contained no image data.');
  }

  const extension = OUTPUT_EXTENSIONS[readOptionalString(payload.output_format) ?? 'png'] ?? 'png';
  const fileName = `${Date.now()}-${randomBytes(4).toString('hex')}-generated.${extension}`;
  const assetsDir = getGlobalImageAssetsDir();
  await fs.mkdir(assetsDir, { recursive: true });
  const filePath = path.join(assetsDir, fileName);
  await fs.writeFile(filePath, Buffer.from(base64, 'base64'));

  return {
    filePath: toPosixPath(filePath),
    url: `/api/assets/images/${fileName}`,
    model: gateway.model,
    size: readOptionalString(payload.size) ?? null,
  };
}
