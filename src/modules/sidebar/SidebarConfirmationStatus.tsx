import type { TFunction } from 'i18next';

/** GOLDJAXE fork (реестр §4.1-тер): отдельная метка решения, не сигнал новой активности. */
export default function SidebarConfirmationStatus({ t }: { t: TFunction }) {
  const label = t('tooltips.waitingForConfirmation', { defaultValue: 'Waiting for confirmation' });
  return (
    <span role="status" title={label} className="block max-w-full shrink-0 truncate text-[11px] font-medium leading-4 text-amber-800 dark:text-amber-300">
      {label}
    </span>
  );
}
