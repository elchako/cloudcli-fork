import { useEffect, useState } from 'react';

import { authenticatedFetch } from '@/shared/api';

import { ImageLightbox } from '@/modules/chat/transcript/ChatMessageImages';

type FilePathLightboxProps = {
  /** Absolute or project-relative path the chat linked to. */
  path: string;
  projectId?: string | null;
  onClose: () => void;
};

/**
 * Shows an image referenced by path in a chat message. The bytes need the auth
 * header, so they are fetched as a blob rather than handed to `<img src>`.
 *
 * Two sources are tried in order: the project file endpoint, then the
 * local-media endpoint for allowlisted directories — agent screenshots usually
 * land in /tmp, which sits outside every project root.
 */
export default function FilePathLightbox({ path, projectId, onClose }: FilePathLightboxProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const isAbsolutePath = path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path);
    const candidateUrls = [
      projectId
        ? `/api/file-tree/projects/${projectId}/files/content?path=${encodeURIComponent(path)}`
        : null,
      isAbsolutePath ? `/api/assets/local-media?path=${encodeURIComponent(path)}` : null,
    ].filter((candidate): candidate is string => candidate !== null);

    let objectUrl: string | null = null;
    const controller = new AbortController();

    const load = async () => {
      setFailed(false);
      setSrc(null);

      for (const url of candidateUrls) {
        try {
          const response = await authenticatedFetch(url, { signal: controller.signal });
          if (!response.ok) {
            continue;
          }
          const blob = await response.blob();
          if (controller.signal.aborted) {
            return;
          }
          objectUrl = URL.createObjectURL(blob);
          setSrc(objectUrl);
          return;
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            return;
          }
        }
      }
      setFailed(true);
    };

    void load();

    return () => {
      controller.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [path, projectId]);

  const fileName = path.split(/[\\/]/).pop() || path;

  if (failed) {
    return (
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-8 backdrop-blur-sm"
        onClick={onClose}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex flex-col items-center gap-2 text-center text-white/80">
          <p className="text-sm">Unable to display this image.</p>
          <p className="break-all text-xs text-white/60">{path}</p>
        </div>
      </div>
    );
  }

  if (!src) {
    return null;
  }

  return <ImageLightbox src={src} alt={fileName} onClose={onClose} />;
}
