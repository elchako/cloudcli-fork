import { useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../../utils/api';

/**
 * Renders a markdown image (`![](url)`) inside chat.
 *
 * External `http(s)` / `data:` URLs render as a plain <img src>. Protected
 * same-origin API URLs (`/api/...`, e.g. `/api/assets/images/foo.png`) cannot
 * carry the `Authorization` header through a bare <img>, so they are fetched as
 * blobs via `authenticatedFetch` (same pattern as `useChatImageSrc`) and shown
 * through an object URL. This lets agents surface screenshots natively with a
 * simple `![alt](/api/assets/images/<file>)` without leaking the JWT into the DOM.
 */

// Needs authenticated blob fetch: same-origin API paths under /api/.
const needsAuthFetch = (src?: string): boolean =>
  !!src && (src.startsWith('/api/') || /^https?:\/\/[^/]+\/api\//i.test(src));

type MarkdownImageProps = {
  src?: string;
  alt?: string;
  title?: string;
};

export function MarkdownImage({ src, alt, title }: MarkdownImageProps) {
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(needsAuthFetch(src) ? null : src ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!src) {
      setResolvedSrc(null);
      setFailed(true);
      return;
    }

    if (!needsAuthFetch(src)) {
      setResolvedSrc(src);
      setFailed(false);
      return;
    }

    let objectUrl: string | null = null;
    const controller = new AbortController();

    const load = async () => {
      setFailed(false);
      try {
        const response = await authenticatedFetch(src, { signal: controller.signal });
        if (!response.ok) {
          setFailed(true);
          return;
        }
        const blob = await response.blob();
        objectUrl = URL.createObjectURL(blob);
        setResolvedSrc(objectUrl);
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          return;
        }
        setFailed(true);
      }
    };

    void load();

    return () => {
      controller.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [src]);

  const altText = alt || title || 'Image';

  if (failed) {
    return (
      <span className="inline-flex items-center rounded-md border border-border/50 bg-muted px-2 py-1 text-xs text-muted-foreground">
        {altText}
      </span>
    );
  }

  if (!resolvedSrc) {
    return <span className="inline-block h-24 w-24 animate-pulse rounded-md border border-border/50 bg-muted align-middle" />;
  }

  return (
    <img
      src={resolvedSrc}
      alt={altText}
      title={title}
      loading="lazy"
      className="my-2 max-h-[70vh] max-w-full rounded-lg border border-border/50 object-contain"
    />
  );
}
