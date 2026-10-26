import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { WheelEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react';

import { cn } from '@/shared/utils';

/**
 * GOLDJAXE fork (реестр §17): the right-edge table of contents of the user's
 * own prompts. Presentational — which prompts exist, which one is current and
 * how a jump happens are decided by usePromptNavigator.
 *
 * With a mouse it is a column of short bars that widen on hover, the hovered
 * one naming its prompt in a tooltip; a click jumps there. Touch has no hover
 * and the bars are far too small to hit one by one, so a tap anywhere on the
 * column opens the same prompts as a readable list instead. Which of the two a
 * tap is comes from the tap's own pointer type, not a media query: hybrid
 * devices answer `(hover: hover)` either way.
 */

export type PromptNavigatorItem = {
  key: string;
  /** The prompt as one line of text; empty for an attachment-only turn. */
  text: string;
  /** Images and files sent with the prompt, named when there is no text. */
  attachmentCount: number;
  /** A slash command rather than a prompt; its bar is drawn quieter. */
  isCommand?: boolean;
};

type ChatPromptNavigatorProps = {
  items: PromptNavigatorItem[];
  /** The prompt whose turn is on screen, -1 before the first one. */
  activeIndex: number;
  canStepBack: boolean;
  canStepForward: boolean;
  /** True while an older part of the history loads for a jump. */
  isBusy: boolean;
  /** Insets from the pane's edges, clear of its scrollbar and the quick-settings handle. */
  placement: { right: number; top: number; bottom: number };
  onSelect: (index: number) => void;
  onStep: (direction: -1 | 1) => void;
  /** The column overlays the transcript; a wheel over it still scrolls the transcript. */
  onWheelTranscript: (deltaY: number) => void;
};

type HoverState = { index: number; top: number };

const LINE_HEIGHT_PX = 16;

export default function ChatPromptNavigator({
  items,
  activeIndex,
  canStepBack,
  canStepForward,
  isBusy,
  placement,
  onSelect,
  onStep,
  onWheelTranscript,
}: ChatPromptNavigatorProps) {
  const { t } = useTranslation('chat');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const lastPointerTypeRef = useRef<string>('mouse');
  const isPointerInsideRef = useRef(false);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [overflow, setOverflow] = useState({ above: false, below: false });
  const [isPanelOpen, setIsPanelOpen] = useState(false);

  const labelFor = useCallback((item: PromptNavigatorItem) => (
    item.text || t('promptNavigator.attachmentsOnly', {
      count: item.attachmentCount,
      defaultValue: 'Attachments: {{count}}',
    })
  ), [t]);

  const updateOverflow = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const next = {
      above: list.scrollTop > 1,
      below: list.scrollTop + list.clientHeight < list.scrollHeight - 1,
    };
    setOverflow((previous) => (
      previous.above === next.above && previous.below === next.below ? previous : next
    ));
  }, []);

  // Keeps the current prompt's bar in the middle of the column when there are
  // more bars than fit — unless the pointer is over it, where the user may be
  // wheeling through the bars themselves.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (activeIndex >= 0 && !isPointerInsideRef.current) {
      const bar = list.querySelector<HTMLElement>(`[data-prompt-index="${activeIndex}"]`);
      if (bar) {
        list.scrollTop = bar.offsetTop - list.clientHeight / 2 + bar.offsetHeight / 2;
      }
    }
    updateOverflow();
  }, [activeIndex, items.length, updateOverflow]);

  // The touch list closes on a tap anywhere outside it and the column. Bubble
  // phase, and the list is not portaled: a tap on a row is handled by the row.
  useEffect(() => {
    if (!isPanelOpen) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !panelRef.current?.contains(target)) {
        setIsPanelOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsPanelOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isPanelOpen]);

  // The list opens on the current prompt rather than on the top of a long
  // list. Only the list scrolls: scrollIntoView would also move the page
  // behind it on a phone.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!isPanelOpen || !panel || activeIndex < 0) return;
    const row = panel.querySelector<HTMLElement>(`[data-prompt-row="${activeIndex}"]`);
    if (row) {
      panel.scrollTop = row.offsetTop - panel.clientHeight / 2 + row.offsetHeight / 2;
    }
  }, [isPanelOpen, activeIndex]);

  const showTooltip = useCallback((index: number, bar: HTMLElement) => {
    const nav = navRef.current;
    if (!nav || lastPointerTypeRef.current === 'touch') return;
    const barBounds = bar.getBoundingClientRect();
    setHover({ index, top: barBounds.top + barBounds.height / 2 - nav.getBoundingClientRect().top });
  }, []);

  const handleWheel = useCallback((event: WheelEvent<HTMLElement>) => {
    const list = listRef.current;
    const overList = Boolean(list && list.contains(event.target as Node));
    const listCanScroll = overList && list && (
      event.deltaY < 0
        ? list.scrollTop > 0
        : list.scrollTop + list.clientHeight < list.scrollHeight - 1
    );
    if (!listCanScroll) {
      const scale = event.deltaMode === 1 ? LINE_HEIGHT_PX : event.deltaMode === 2 ? window.innerHeight : 1;
      onWheelTranscript(event.deltaY * scale);
    }
  }, [onWheelTranscript]);

  if (items.length < 2) {
    return null;
  }

  const chevronClassName = 'flex h-7 w-6 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30 sm:w-7';
  const overflowDot = (visible: boolean) => (
    <span
      aria-hidden
      className={cn(
        'mr-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-muted-foreground/60 transition-opacity',
        visible ? 'opacity-100' : 'opacity-0',
      )}
    />
  );

  return (
    <>
      <div
        ref={rootRef}
        className="pointer-events-none absolute z-20 flex items-center"
        style={placement}
      >
        <nav
          ref={navRef}
          aria-label={t('promptNavigator.label', { defaultValue: 'Your prompts' })}
          aria-busy={isBusy || undefined}
          className="group/prompts pointer-events-auto relative flex max-h-[70%] flex-col items-end gap-1"
          onPointerDown={(event) => {
            lastPointerTypeRef.current = event.pointerType;
          }}
          onMouseEnter={() => {
            isPointerInsideRef.current = true;
          }}
          onMouseLeave={() => {
            isPointerInsideRef.current = false;
            setHover(null);
          }}
          onWheel={handleWheel}
        >
          <button
            type="button"
            className={chevronClassName}
            onClick={() => onStep(-1)}
            disabled={!canStepBack}
            aria-label={t('promptNavigator.previous', { defaultValue: 'Previous prompt' })}
            title={t('promptNavigator.previous', { defaultValue: 'Previous prompt' })}
          >
            <ChevronUpIcon className="h-4 w-4" aria-hidden />
          </button>

          {overflowDot(overflow.above)}

          <div
            ref={listRef}
            onScroll={() => {
              updateOverflow();
              setHover(null);
            }}
            className={cn(
              'flex min-h-0 flex-1 flex-col items-end overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
              isBusy && 'animate-pulse',
            )}
          >
            {items.map((item, index) => {
              const isActive = index === activeIndex;
              return (
                <button
                  key={item.key}
                  type="button"
                  data-prompt-index={index}
                  onClick={() => {
                    // A tap cannot aim at a 10px bar: it opens the readable list.
                    if (lastPointerTypeRef.current === 'touch') {
                      setIsPanelOpen((open) => !open);
                      return;
                    }
                    onSelect(index);
                  }}
                  onMouseEnter={(event) => showTooltip(index, event.currentTarget)}
                  onFocus={(event) => showTooltip(index, event.currentTarget)}
                  onBlur={() => setHover(null)}
                  aria-label={labelFor(item)}
                  aria-current={isActive ? 'location' : undefined}
                  className="flex h-2.5 w-6 flex-shrink-0 items-center justify-end pr-1.5 focus-visible:outline-none sm:w-10"
                >
                  <span
                    aria-hidden
                    className={cn(
                      'block h-[3px] rounded-full transition-all duration-150 motion-reduce:transition-none',
                      isActive
                        ? 'w-4 bg-foreground group-hover/prompts:w-7'
                        : cn(
                          'w-2.5 group-hover/prompts:w-5',
                          item.isCommand
                            ? 'bg-muted-foreground/25 group-hover/prompts:bg-muted-foreground/45'
                            : 'bg-muted-foreground/45 group-hover/prompts:bg-muted-foreground/70',
                        ),
                      hover?.index === index && 'bg-foreground',
                    )}
                  />
                </button>
              );
            })}
          </div>

          {overflowDot(overflow.below)}

          <button
            type="button"
            className={chevronClassName}
            onClick={() => onStep(1)}
            disabled={!canStepForward}
            aria-label={t('promptNavigator.next', { defaultValue: 'Next prompt' })}
            title={t('promptNavigator.next', { defaultValue: 'Next prompt' })}
          >
            <ChevronDownIcon className="h-4 w-4" aria-hidden />
          </button>

          {hover && items[hover.index] && (
            <div
              role="tooltip"
              className="pointer-events-none absolute right-full mr-2 w-max max-w-[min(22rem,60vw)] -translate-y-1/2 rounded-xl border border-border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-lg"
              style={{ top: hover.top }}
            >
              <span dir="auto" className="line-clamp-3 break-words">{labelFor(items[hover.index])}</span>
            </div>
          )}
        </nav>
      </div>

      {/* The list takes the pane's full height, not the column's stretch
          beside the quick-settings handle: on a phone that stretch is a few
          rows. */}
      {isPanelOpen && (
        <div
          className="pointer-events-none absolute inset-y-2 z-30 flex items-center"
          style={{ right: placement.right + 28 }}
        >
          <div
            ref={panelRef}
            role="dialog"
            aria-label={t('promptNavigator.label', { defaultValue: 'Your prompts' })}
            className="pointer-events-auto max-h-full w-[min(20rem,calc(100vw-4rem))] overflow-y-auto overscroll-contain rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg"
          >
            {items.map((item, index) => (
              <button
                key={item.key}
                type="button"
                data-prompt-row={index}
                onClick={() => {
                  setIsPanelOpen(false);
                  onSelect(index);
                }}
                aria-current={index === activeIndex ? 'location' : undefined}
                className={cn(
                  'flex w-full gap-2 rounded-lg px-3 py-2 text-left text-sm',
                  index === activeIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
                  item.isCommand && 'text-muted-foreground',
                )}
              >
                <span className="flex-shrink-0 tabular-nums text-muted-foreground">{index + 1}.</span>
                <span dir="auto" className="line-clamp-2 min-w-0 break-words">{labelFor(item)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
