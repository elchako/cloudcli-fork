import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { Markdown } from '@/modules/chat/transcript/Markdown';
import { MarkdownWorkspaceContext } from '@/modules/chat/context/MarkdownWorkspaceContext';

const readFileBlob = vi.fn();
const authenticatedFetch = vi.fn();
vi.mock('@/shared/api', () => ({
  api: {
    readFileBlob: (...args: unknown[]) => readFileBlob(...args),
  },
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

/**
 * Fork additions to upstream's MarkdownImage (docs/ru/fork-changes.md §14):
 * CloudCLI's own `/api/...` paths — where generate_image results and uploads
 * live — are fetched with the auth header, but only on our own origin, and an
 * absolute path outside the project falls back to the local-media endpoint.
 */

const OBJECT_URL = 'blob:mock-image';
URL.createObjectURL = vi.fn(() => OBJECT_URL);
URL.revokeObjectURL = vi.fn();

const okBlob = { ok: true, blob: async () => new Blob(['png']) };
const forbidden = { ok: false, blob: async () => new Blob() };

beforeEach(() => {
  readFileBlob.mockReset();
  authenticatedFetch.mockReset();
});

const renderInProject = (markdown: string, projectId: string | null = 'project-1') =>
  render(
    <MarkdownWorkspaceContext.Provider value={{ projectId }}>
      <Markdown>{markdown}</Markdown>
    </MarkdownWorkspaceContext.Provider>,
  );

test('a generated image under /api/assets is fetched with the auth header, not as a workspace file', async () => {
  authenticatedFetch.mockResolvedValue(okBlob);

  const { findByRole } = renderInProject('![logo](/api/assets/images/abc.png)');

  const img = (await findByRole('img')) as HTMLImageElement;
  assert.equal(img.getAttribute('src'), OBJECT_URL);
  assert.equal(authenticatedFetch.mock.calls[0][0], '/api/assets/images/abc.png');
  assert.equal(readFileBlob.mock.calls.length, 0);
});

test('an absolute URL to our own API is fetched with the auth header too', async () => {
  authenticatedFetch.mockResolvedValue(okBlob);
  const url = `${window.location.origin}/api/assets/images/abc.png`;

  await renderInProject(`![logo](${url})`).findByRole('img');

  assert.equal(authenticatedFetch.mock.calls[0][0], url);
});

test('an /api/ URL on another host is left to the browser, so the token never leaves', () => {
  const { getByRole } = renderInProject('![x](https://attacker.example/api/steal.png)');

  const img = getByRole('img') as HTMLImageElement;
  assert.equal(img.getAttribute('src'), 'https://attacker.example/api/steal.png');
  assert.equal(authenticatedFetch.mock.calls.length, 0);
});

test('an absolute path outside the project falls back to local-media', async () => {
  readFileBlob.mockResolvedValue(forbidden);
  authenticatedFetch.mockResolvedValue(okBlob);

  const img = (await renderInProject('![shot](/tmp/shot.png)').findByRole('img')) as HTMLImageElement;

  assert.equal(img.getAttribute('src'), OBJECT_URL);
  assert.deepEqual(readFileBlob.mock.calls[0].slice(0, 2), ['project-1', '/tmp/shot.png']);
  assert.equal(authenticatedFetch.mock.calls[0][0], '/api/assets/local-media?path=%2Ftmp%2Fshot.png');
});

test('without a project an absolute path still goes to local-media', async () => {
  authenticatedFetch.mockResolvedValue(okBlob);

  await renderInProject('![shot](/tmp/shot.png)', null).findByRole('img');

  assert.equal(readFileBlob.mock.calls.length, 0);
  assert.equal(authenticatedFetch.mock.calls[0][0], '/api/assets/local-media?path=%2Ftmp%2Fshot.png');
});

test('when every source refuses, the alt text is shown', async () => {
  readFileBlob.mockResolvedValue(forbidden);
  authenticatedFetch.mockResolvedValue(forbidden);

  const { findByText, queryByRole } = renderInProject('![shot](/tmp/missing.png)');

  await findByText('shot');
  assert.equal(queryByRole('img'), null);
});
