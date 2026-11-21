import { LockIcon, XIcon } from 'lucide-react';

import { useProtectedDataCopy } from '@/modules/chat/protected-data/protected-data-copy';
import '@/modules/chat/protected-data/protected-data.css';

export type ProtectedDataChipProps = {
  count: number;
  onEdit: () => void;
  onRemove: () => void;
  disabled?: boolean;
};

const CHIP_BUTTON = 'protected-data-chip-button relative flex h-8 items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring enabled:hover:bg-accent disabled:opacity-50';

// GOLDJAXE fork (реестр §27): в композере видны только замок и количество полей.
export function ProtectedDataChip({ count, onEdit, onRemove, disabled }: ProtectedDataChipProps) {
  const copy = useProtectedDataCopy();
  if (count <= 0) return null;
  const countLabel = copy.count(count);

  return (
    <div className="inline-flex max-w-full items-center rounded-lg border border-border bg-muted/40 text-sm text-foreground"
      onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        className={`${CHIP_BUTTON} gap-1.5 rounded-l-[7px] px-2.5`}
        aria-label={`${copy.edit}: ${countLabel}`}
        aria-haspopup="dialog"
        onClick={onEdit}
        disabled={disabled}
      >
        <LockIcon className="h-4 w-4 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
        <span>{countLabel}</span>
      </button>
      <button
        type="button"
        className={`${CHIP_BUTTON} protected-data-chip-remove w-8 rounded-r-[7px] text-muted-foreground`}
        aria-label={copy.remove}
        title={copy.remove}
        onClick={onRemove}
        disabled={disabled}
      >
        <XIcon className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  );
}
