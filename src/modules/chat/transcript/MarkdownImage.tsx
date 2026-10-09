import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ImageOff } from 'lucide-react';

import { api, authenticatedFetch } from '@/shared/api';
import { useMarkdownWorkspaceProjectId } from '@/modules/chat/context/MarkdownWorkspaceContext';
import { ImageLightbox } from '@/modules/chat/transcript/ChatMessageImages';

type MarkdownImageProps = {
  node?: unknown;
  src?: string;
  alt?: string;
  title?: string;
};

// Sources the browser can load on its own. Anything else is a workspace file
// reference and has to go through the authenticated project files route.
const isBrowserLoadableSrc = (src: string): boolean => /^(https?:|data:|blob:)/i.test(src);

// Turn the markdown src into the path the file-tree route expects. Relative
// paths are resolved against the project root server-side; absolute paths are
// accepted as long as they stay inside it.
const toWorkspacePath = (src: string): string => {
  let workspacePath = src.trim();
  if (workspacePath.startsWith('file://')) {
    workspacePath = workspacePath.slice('file://'.length);
  }
  if (workspacePath.startsWith('./')) {
    workspacePath = workspacePath.slice(2);
  }
  try {
    workspacePath = decodeURI(workspacePath);
  } catch {
    // Keep the raw value when it is not valid percent-encoding.
  }
  return workspacePath;
};

// Fork: CloudCLI's own API paths (`/api/assets/images/…` — generate_image
// results, uploaded attachments) need the auth header as well, but they are
// not workspace files. Only same-origin URLs qualify: the request carries the
// JWT, so it must never go to some other host a model happened to write down.
const toOwnApiUrl = (src: string): string | null => {
  if (src.startsWith('/api/')) {
    return src;
  }
  if (!/^https?:\/\//i.test(src)) {
    return null;
  }
  try {
    const url = new URL(src);
    return url.origin === window.location.origin && url.pathname.startsWith('/api/') ? src : null;
  } catch {
    return null;
  }
};

const isAbsolutePath = (path: string): boolean => path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path);

type ImageRequest = (signal: AbortSignal) => Promise<Response>;

// Fork: where a non-web src can be fetched from, in order. Upstream only asks
// the project files route; we add our own API paths and, for absolute paths
// outside the project (agent screenshots in /tmp), the allowlisted
// local-media endpoint — the same chain as the editor's media preview.
const imageRequests = (src: string, projectId: string | null): ImageRequest[] => {
  const apiUrl = toOwnApiUrl(src);
  if (apiUrl) {
    return [(signal) => authenticatedFetch(apiUrl, { signal })];
  }
  const workspacePath = toWorkspacePath(src);
  const requests: ImageRequest[] = [];
  if (projectId) {
    requests.push((signal) => api.readFileBlob(projectId, workspacePath, { signal }));
  }
  if (isAbsolutePath(workspacePath)) {
    requests.push((signal) =>
      authenticatedFetch(`/api/assets/local-media?path=${encodeURIComponent(workspacePath)}`, { signal }),
    );
  }
  return requests;
};

type LoadedImage = { key: string; url: string | null; failed: boolean };

/**
 * Resolves a markdown image src to something an <img> can display. Web, data
 * and blob URLs pass through untouched; workspace paths are fetched as blobs
 * (a bare <img src> cannot carry the auth header) and exposed as object URLs.
 */
function useMarkdownImageSrc(src: string, projectId: string | null): { src: string | null; failed: boolean } {
  const passthrough = isBrowserLoadableSrc(src) && !toOwnApiUrl(src);
  // Keyed by what was requested so a src change reads as "loading" until the
  // new fetch settles, without resetting state synchronously in the effect.
  const key = `${projectId ?? ''}:${src}`;
  const [loaded, setLoaded] = useState<LoadedImage | null>(null);
  const hasSource = passthrough || imageRequests(src, projectId).length > 0;

  useEffect(() => {
    const requests = passthrough ? [] : imageRequests(src, projectId);
    if (requests.length === 0) {
      return;
    }

    let objectUrl: string | null = null;
    const controller = new AbortController();

    const load = async () => {
      for (const request of requests) {
        try {
          const response = await request(controller.signal);
          if (!response.ok) {
            continue;
          }
          const blob = await response.blob();
          objectUrl = URL.createObjectURL(blob);
          setLoaded({ key, url: objectUrl, failed: false });
          return;
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            return;
          }
        }
      }
      setLoaded({ key, url: null, failed: true });
    };

    void load();

    return () => {
      controller.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [key, passthrough, projectId, src]);

  if (passthrough) {
    return { src, failed: false };
  }
  if (!hasSource) {
    return { src: null, failed: true };
  }
  const current = loaded && loaded.key === key ? loaded : null;
  return { src: current?.url ?? null, failed: current?.failed ?? false };
}

/**
 * `img` renderer for chat markdown. Shows images the model references by
 * workspace path (screenshots it took, files it generated) inline, with the
 * same click-to-expand lightbox as user attachments. Used by the shared
 * Markdown component overrides.
 */
export function MarkdownImage({ node: _node, src, alt, title }: MarkdownImageProps) {
  const { t } = useTranslation();
  const projectId = useMarkdownWorkspaceProjectId();
  const source = src ?? '';
  const { src: resolved, failed } = useMarkdownImageSrc(source, projectId);
  const [expanded, setExpanded] = useState(false);

  if (!source) {
    return null;
  }

  const label = alt || title || source;

  if (failed) {
    return (
      <span
        className="my-1 inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/60 bg-muted px-2 py-1 text-xs text-muted-foreground"
        title={source}
      >
        <ImageOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </span>
    );
  }

  if (!resolved) {
    return <span className="my-2 block h-40 max-w-md animate-pulse rounded-xl border border-border/50 bg-muted" />;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded(true)}
        aria-label={t('chat:misc.expandImage', { name: label })}
        className="my-2 block max-w-full overflow-hidden rounded-xl border border-border/50 bg-muted/30 shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/60"
      >
        <img
          src={resolved}
          alt={alt ?? ''}
          title={title}
          loading="lazy"
          className="block max-h-96 max-w-full cursor-zoom-in object-contain"
        />
      </button>
      {expanded && <ImageLightbox src={resolved} alt={label} onClose={() => setExpanded(false)} />}
    </>
  );
}
