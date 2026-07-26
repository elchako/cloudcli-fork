import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';

import { isImageFile } from '../../utils/attachmentSupport';

interface ImageAttachmentProps {
  file: File;
  onRemove: () => void;
  uploadProgress?: number;
  error?: string;
}

const fileExtension = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toUpperCase() : 'FILE';
};

const ImageAttachment = ({ file, onRemove, uploadProgress, error }: ImageAttachmentProps) => {
  const [preview, setPreview] = useState<string | undefined>(undefined);
  const isImage = isImageFile(file);

  useEffect(() => {
    if (!isImage) {
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file, isImage]);

  return (
    <div className="group relative">
      <div className="overflow-hidden rounded-xl border border-border/50 shadow-sm">
        {isImage ? (
          <img src={preview} alt={file.name} className="h-20 w-20 object-cover" />
        ) : (
          <div className="flex h-20 w-20 flex-col items-center justify-center gap-1 bg-muted px-1 text-center">
            <FileText className="h-6 w-6 text-muted-foreground" />
            <span className="text-[9px] font-semibold uppercase text-muted-foreground">{fileExtension(file.name)}</span>
            <span className="w-full truncate text-[9px] text-muted-foreground" title={file.name}>{file.name}</span>
          </div>
        )}
      </div>
      {uploadProgress !== undefined && uploadProgress < 100 && (
        <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/50">
          <div className="text-xs text-white">{uploadProgress}%</div>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-red-500/50">
          <svg className="h-6 w-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </div>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="absolute -right-1.5 -top-1.5 rounded-full border border-border/40 bg-background/90 p-1 text-foreground shadow-sm backdrop-blur transition-opacity hover:bg-background focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
        aria-label="Remove attachment"
      >
        <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
};

export default ImageAttachment;


