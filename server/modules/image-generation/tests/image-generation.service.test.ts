import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { buildImageToolResultText } from '@/modules/image-generation/image-generation.mcp.js';
import { generateImage, resolveImageGateway } from '@/modules/image-generation/image-generation.service.js';

// Keys are restored one by one: swapping `process.env` for a plain object would stop HOME
// changes from reaching the real environment, and `os.homedir()` reads the real one.
const TOUCHED_ENV = [
  'HOME',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLOUDCLI_IMAGE_GEN',
  'CLOUDCLI_IMAGE_MODEL',
] as const;
const originalEnv = Object.fromEntries(TOUCHED_ENV.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

function restoreEnv() {
  for (const key of TOUCHED_ENV) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
}

// 1x1 transparent PNG — enough for the service to decode and store.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** Replaces fetch with a stub and records the requests it received. */
function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof globalThis.fetch;
  return calls;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const imageResponse = () => jsonResponse({ data: [{ b64_json: PNG_BASE64 }], output_format: 'png', size: '1254x1254' });

describe('image generation service', () => {
  let home: string;
  let cwd: string;

  beforeEach(async () => {
    // A throwaway HOME keeps the developer's real gateway and assets folder out of the tests.
    home = await mkdtemp(path.join(os.tmpdir(), 'image-gen-home-'));
    cwd = await mkdtemp(path.join(os.tmpdir(), 'image-gen-project-'));
    process.env.HOME = home;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLOUDCLI_IMAGE_GEN;
    delete process.env.CLOUDCLI_IMAGE_MODEL;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    restoreEnv();
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  it('offers no gateway without ANTHROPIC_BASE_URL — the public API has no image endpoints', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    assert.equal(await resolveImageGateway(), null);
  });

  it('can be switched off even when a gateway is configured', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.test';
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
    process.env.CLOUDCLI_IMAGE_GEN = 'off';
    assert.equal(await resolveImageGateway(), null);
  });

  it('picks the gateway up from ~/.claude/settings.json like the Claude CLI does', async () => {
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'https://gateway.test/', ANTHROPIC_AUTH_TOKEN: 'settings-token' },
    }));

    assert.deepEqual(await resolveImageGateway(), {
      baseUrl: 'https://gateway.test',
      token: 'settings-token',
      model: 'gpt-image-2.5',
    });
  });

  it('generates through the gateway and stores the picture next to chat uploads', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.test';
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
    const calls = stubFetch(() => imageResponse());

    const image = await generateImage({ prompt: '  golden axe icon  ', size: '1024x1024', quality: 'low', cwd });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://gateway.test/v1/images/generations');
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer test-token');
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      model: 'gpt-image-2.5',
      prompt: 'golden axe icon',
      n: 1,
      size: '1024x1024',
      quality: 'low',
    });

    const fileName = path.basename(image.filePath);
    // The assets route only serves direct children with plain names.
    assert.match(fileName, /^[0-9a-z.-]+\.png$/);
    assert.equal(path.dirname(image.filePath), path.join(home, '.cloudcli', 'assets'));
    assert.equal(image.url, `/api/assets/images/${fileName}`);
    assert.equal(image.size, '1254x1254');
    assert.deepEqual(await readFile(image.filePath), Buffer.from(PNG_BASE64, 'base64'));
  });

  it('uses the model from CLOUDCLI_IMAGE_MODEL when set', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.test';
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
    process.env.CLOUDCLI_IMAGE_MODEL = 'gpt-image-2.5-flare';
    const calls = stubFetch(() => imageResponse());

    const image = await generateImage({ prompt: 'a red dot', cwd });

    assert.equal(JSON.parse(String(calls[0].init.body)).model, 'gpt-image-2.5-flare');
    assert.equal(image.model, 'gpt-image-2.5-flare');
  });

  it('sends project images to the edits endpoint as references', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.test';
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
    await writeFile(path.join(cwd, 'logo.png'), Buffer.from(PNG_BASE64, 'base64'));
    const calls = stubFetch(() => imageResponse());

    await generateImage({ prompt: 'make the background white', inputImages: ['logo.png'], cwd });

    assert.equal(calls[0].url, 'https://gateway.test/v1/images/edits');
    const form = calls[0].init.body as FormData;
    assert.ok(form instanceof FormData);
    assert.equal(form.get('model'), 'gpt-image-2.5');
    assert.equal(form.get('prompt'), 'make the background white');
    const images = form.getAll('image[]');
    assert.equal(images.length, 1);
    assert.equal((images[0] as File).name, 'logo.png');
    assert.equal((images[0] as File).type, 'image/png');
  });

  it('refuses reference images outside the project and the assets folder', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.test';
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
    const outside = await mkdtemp(path.join(os.tmpdir(), 'image-gen-outside-'));
    try {
      await writeFile(path.join(outside, 'secret.png'), Buffer.from(PNG_BASE64, 'base64'));
      const calls = stubFetch(() => imageResponse());

      await assert.rejects(
        generateImage({ prompt: 'edit', inputImages: [path.join(outside, 'secret.png')], cwd }),
        /inside the project or ~\/\.cloudcli\/assets/,
      );
      assert.equal(calls.length, 0);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a reference that is not a PNG, JPEG or WebP image', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.test';
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
    await writeFile(path.join(cwd, 'notes.txt'), 'not an image');
    const calls = stubFetch(() => imageResponse());

    await assert.rejects(
      generateImage({ prompt: 'edit', inputImages: ['notes.txt'], cwd }),
      /must be PNG, JPEG or WebP/,
    );
    assert.equal(calls.length, 0);
  });

  it('surfaces the gateway error message', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.test';
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
    stubFetch(() => jsonResponse({ error: { message: "Invalid value: 'invisible'." } }, 400));

    await assert.rejects(
      generateImage({ prompt: 'a red dot', cwd }),
      /Image gateway returned 400: Invalid value: 'invisible'\./,
    );
  });

  it('fails clearly when no gateway is configured', async () => {
    await assert.rejects(generateImage({ prompt: 'a red dot', cwd }), /not available/);
  });
});

describe('generate_image tool result', () => {
  it('gives the model the file path and the chat a renderable image line', () => {
    const text = buildImageToolResultText(
      {
        filePath: '/home/user/.cloudcli/assets/1-ab-generated.png',
        url: '/api/assets/images/1-ab-generated.png',
        model: 'gpt-image-2.5',
        size: '1254x1254',
      },
      'A [golden] axe\non navy',
    );

    assert.match(text, /already displayed to the user/);
    assert.match(text, /Saved to: \/home\/user\/\.cloudcli\/assets\/1-ab-generated\.png/);
    // Brackets and line breaks in the prompt must not break the markdown image.
    assert.match(text, /^!\[A golden axe on navy\]\(\/api\/assets\/images\/1-ab-generated\.png\)$/m);
  });
});
