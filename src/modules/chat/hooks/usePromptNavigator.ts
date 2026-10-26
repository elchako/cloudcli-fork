import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';

import { api } from '@/shared/api';
import type { ChatMessage } from '@/shared/types';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import { SESSION_MESSAGES_PAGE_SIZE } from '@/modules/chat/utils/sessionMessagePagination';
import {
  collectLoadedPrompts,
  findActivePromptIndex,
  findLoadedPromptIndex,
  mergePrompts,
} from '@/modules/chat/utils/promptNavigator';
import type { ServerPrompt } from '@/modules/chat/utils/promptNavigator';

/**
 * GOLDJAXE fork (реестр §17): state and behavior behind ChatPromptNavigator —
 * the session's prompt list, the prompt the reader is in, and the jump to one.
 */

/** Coalesces the list refresh after a run ends and the history settles. */
const PROMPTS_REFRESH_DELAY_MS = 300;

/**
 * How long a jump keeps re-aligning its row. Rows mount around the target as
 * it comes into view and images load after that, each shifting it; browser
 * scroll anchoring does not absorb that everywhere (Safari has none).
 */
const ALIGN_DURATION_MS = 2000;

/** How far a prompt must be scrolled past its jump position to count as "inside" its turn. */
const MID_TURN_SLACK_PX = 24;

/** Space below the sticky header (export menu, background tasks) a jumped-to row keeps. */
const ALIGN_GAP_PX = 8;

/** Where the column sits over the pane: clear of its scrollbar and of the quick-settings handle. */
export type PromptNavigatorPlacement = {
  right: number;
  top: number;
  bottom: number;
};

const DEFAULT_PLACEMENT: PromptNavigatorPlacement = { right: 4, top: 0, bottom: 0 };

/** How far in from the pane's right edge the column reaches when widened on hover. */
const COLUMN_REACH_PX = 72;

type ServerPromptList = {
  sessionId: string;
  prompts: ServerPrompt[];
  total: number;
};

type NavigatorView = {
  active: number;
  /** True when the active prompt's row is above its jump position: ↑ returns to it first. */
  midTurn: boolean;
};

type UsePromptNavigatorArgs = {
  sessionId: string | null;
  isActive: boolean;
  isProcessing: boolean;
  chatMessages: ChatMessage[];
  visibleMessages: ChatMessage[];
  scrollContainerRef: RefObject<HTMLDivElement>;
  sessionStore: SessionStore;
  revealRowAt: (total: number, index: number) => void;
  setIsUserScrolledUp: (value: boolean) => void;
};

/**
 * The transcript's rendered rows by timestamp. Rows are the grandchildren of
 * the scroll container (pane › list › row wrapper), and walking only those is
 * what keeps this cheap enough to run on every scroll frame of a long
 * transcript; the first row carrying a timestamp wins, as in the search jump.
 */
function readRenderedRows(container: HTMLElement): Map<string, HTMLElement> {
  const rows = new Map<string, HTMLElement>();
  for (const section of Array.from(container.children)) {
    for (const child of Array.from(section.children)) {
      const timestamp = child.getAttribute('data-message-timestamp');
      if (timestamp && !rows.has(timestamp)) {
        rows.set(timestamp, child as HTMLElement);
      }
    }
  }
  return rows;
}

function findRenderedRow(container: HTMLElement, timestamp: string): HTMLElement | null {
  const escaped = timestamp.replace(/["\\]/g, '\\$&');
  return container.querySelector<HTMLElement>(`[data-message-timestamp="${escaped}"]`);
}

/** Where a jumped-to row's top lands: just under the sticky header that overlays the transcript's top. */
function readAlignOffset(container: HTMLElement): number {
  const header = container.querySelector<HTMLElement>(':scope > .sticky');
  if (!header) {
    return ALIGN_GAP_PX * 2;
  }
  return header.getBoundingClientRect().bottom - container.getBoundingClientRect().top + ALIGN_GAP_PX;
}

/**
 * Keeps the column below the sticky header (export menu, background tasks)
 * and clear of the quick-settings handle, which is fixed to the pane's right
 * edge at a height the user drags it to — exactly where the column is. When
 * the handle is in the way, the column takes the larger free stretch above or
 * below it.
 */
function readPlacement(container: HTMLElement): PromptNavigatorPlacement {
  // Overlay scrollbars are 0 wide; a classic one is not, and the column must
  // not sit on top of it.
  const right = Math.max(0, container.offsetWidth - container.clientWidth) + 4;
  const headerClearance = Math.round(readAlignOffset(container));
  const handle = document.querySelector<HTMLElement>('[data-quick-settings-handle]');
  if (!handle) {
    return { right, top: headerClearance, bottom: 0 };
  }

  const pane = container.getBoundingClientRect();
  const bounds = handle.getBoundingClientRect();
  const inTheWay = bounds.left < pane.right
    && bounds.right > pane.right - COLUMN_REACH_PX
    && bounds.bottom > pane.top
    && bounds.top < pane.bottom;
  if (!inTheWay) {
    return { right, top: headerClearance, bottom: 0 };
  }

  const spaceAbove = bounds.top - pane.top - headerClearance;
  const spaceBelow = pane.bottom - bounds.bottom;
  return spaceAbove >= spaceBelow
    ? { right, top: headerClearance, bottom: Math.round(pane.bottom - bounds.top + ALIGN_GAP_PX) }
    : { right, top: Math.max(headerClearance, Math.round(bounds.bottom - pane.top + ALIGN_GAP_PX)), bottom: 0 };
}

/** A short ring around the prompt's bubble, so the eye finds where the jump landed. */
function flashPromptBubble(row: HTMLElement): boolean {
  const target = row.querySelector<HTMLElement>('.chat-message.user .rounded-2xl')
    ?? row.querySelector<HTMLElement>('.chat-message');
  if (!target) {
    return false;
  }
  if (typeof target.animate === 'function') {
    const primary = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();
    const ring = primary ? `hsl(${primary})` : 'currentColor';
    target.animate(
      [
        { boxShadow: `0 0 0 2px ${ring}` },
        { boxShadow: `0 0 0 2px ${ring}`, offset: 0.5 },
        { boxShadow: '0 0 0 2px transparent' },
      ],
      { duration: 2400, easing: 'ease-out' },
    );
  }
  return true;
}

export function usePromptNavigator({
  sessionId,
  isActive,
  isProcessing,
  chatMessages,
  visibleMessages,
  scrollContainerRef,
  sessionStore,
  revealRowAt,
  setIsUserScrolledUp,
}: UsePromptNavigatorArgs) {
  const [serverList, setServerList] = useState<ServerPromptList | null>(null);
  const [view, setView] = useState<NavigatorView>({ active: -1, midTurn: false });
  const [isJumping, setIsJumping] = useState(false);
  const [placement, setPlacement] = useState<PromptNavigatorPlacement>(DEFAULT_PLACEMENT);

  /* ---------------------------------------------------------------- */
  /*  The prompt list                                                  */
  /* ---------------------------------------------------------------- */

  // The slot's total changes when the store learns the history grew or was
  // cut (an edit truncates it); while a run streams it is ignored and the
  // list is refreshed once the run ends.
  const slotTotal = sessionId ? sessionStore.getSessionSlot(sessionId)?.total ?? 0 : 0;

  useEffect(() => {
    if (!isActive || !sessionId || isProcessing) {
      return undefined;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await api.providers.sessionPrompts(sessionId, { signal: controller.signal });
        if (!response.ok) {
          return;
        }
        const payload = await response.json();
        const data = payload?.data;
        if (Array.isArray(data?.prompts)) {
          setServerList({ sessionId, prompts: data.prompts, total: Number(data.total) || 0 });
        }
      } catch {
        // Aborted or offline: the loaded prompts still show.
      }
    }, PROMPTS_REFRESH_DELAY_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [isActive, isProcessing, sessionId, slotTotal]);

  const loadedPrompts = useMemo(() => collectLoadedPrompts(chatMessages), [chatMessages]);

  const listForSession = serverList && serverList.sessionId === sessionId ? serverList : null;
  const entries = useMemo(
    () => mergePrompts(listForSession?.prompts ?? null, loadedPrompts),
    [listForSession, loadedPrompts],
  );

  /* ---------------------------------------------------------------- */
  /*  Latest values for listeners and async work                       */
  /* ---------------------------------------------------------------- */

  const listTotal = listForSession?.total ?? 0;
  const latestRef = useRef({ entries, loadedPrompts, chatMessages, listTotal, sessionId, isActive, view, isJumping });
  useLayoutEffect(() => {
    latestRef.current = { entries, loadedPrompts, chatMessages, listTotal, sessionId, isActive, view, isJumping };
  });

  /** The prompt a jump landed on; it stays current until the user scrolls themselves. */
  const pinnedRef = useRef<number | null>(null);
  /** Bumped by every jump and by user input, so stale async steps and align loops stop. */
  const jumpTokenRef = useRef(0);
  const frameRef = useRef(0);

  /* ---------------------------------------------------------------- */
  /*  The prompt the reader is in                                      */
  /* ---------------------------------------------------------------- */

  const updateView = useCallback(() => {
    frameRef.current = 0;
    const container = scrollContainerRef.current;
    if (!container || !latestRef.current.isActive) {
      return;
    }

    const nextPlacement = readPlacement(container);
    setPlacement((previous) => (
      previous.right === nextPlacement.right
      && previous.top === nextPlacement.top
      && previous.bottom === nextPlacement.bottom
        ? previous
        : nextPlacement
    ));

    const currentEntries = latestRef.current.entries;
    const pinned = pinnedRef.current;
    let next: NavigatorView;
    if (pinned !== null && pinned < currentEntries.length) {
      next = { active: pinned, midTurn: false };
    } else {
      // A prompt known by anchor may be rendered under the loaded copy's own
      // timestamp.
      const loadedTimestampByAnchor = new Map<string, string>();
      for (const prompt of latestRef.current.loadedPrompts) {
        if (prompt.anchorId) {
          loadedTimestampByAnchor.set(prompt.anchorId, prompt.timestamp);
        }
      }

      const rows = readRenderedRows(container);
      const containerTop = container.getBoundingClientRect().top;
      const scrollTop = container.scrollTop;
      const tops = currentEntries.map((entry) => {
        const timestamp = (entry.anchorId && loadedTimestampByAnchor.get(entry.anchorId)) || entry.timestamp;
        const row = rows.get(timestamp);
        return row ? row.getBoundingClientRect().top - containerTop + scrollTop : null;
      });

      const alignOffset = readAlignOffset(container);
      const readingLine = scrollTop + Math.max(alignOffset + ALIGN_GAP_PX, container.clientHeight * 0.3);
      const viewportBottom = scrollTop + container.clientHeight;
      const isAtBottom = container.scrollHeight - viewportBottom < 4;
      const active = findActivePromptIndex(tops, readingLine, isAtBottom ? viewportBottom : null);
      const activeTop = active >= 0 ? tops[active] : null;
      next = {
        active,
        // An active prompt with no rendered row is above the screen: the
        // reader is somewhere inside its turn.
        midTurn: active >= 0 && (activeTop === null || activeTop < scrollTop + alignOffset - MID_TURN_SLACK_PX),
      };
    }

    setView((previous) => (
      previous.active === next.active && previous.midTurn === next.midTurn ? previous : next
    ));
  }, [scrollContainerRef]);

  const scheduleUpdate = useCallback(() => {
    if (!frameRef.current) {
      frameRef.current = requestAnimationFrame(updateView);
    }
  }, [updateView]);

  /** User input ends a jump in flight and releases the pin on its prompt. */
  const releaseJump = useCallback(() => {
    if (pinnedRef.current === null && !latestRef.current.isJumping) {
      return;
    }
    jumpTokenRef.current += 1;
    pinnedRef.current = null;
    setIsJumping(false);
    scheduleUpdate();
  }, [scheduleUpdate]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !isActive) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
        releaseJump();
      }
    };

    container.addEventListener('scroll', scheduleUpdate, { passive: true });
    container.addEventListener('wheel', releaseJump, { passive: true });
    container.addEventListener('touchstart', releaseJump, { passive: true });
    container.addEventListener('pointerdown', releaseJump, { passive: true });
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', scheduleUpdate);
    // The quick-settings handle is dropped at a new height on release.
    window.addEventListener('mouseup', scheduleUpdate);
    window.addEventListener('touchend', scheduleUpdate);
    // A docked panel opening or closing resizes the pane without a window resize.
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleUpdate);
    resizeObserver?.observe(container);
    scheduleUpdate();

    return () => {
      container.removeEventListener('scroll', scheduleUpdate);
      container.removeEventListener('wheel', releaseJump);
      container.removeEventListener('touchstart', releaseJump);
      container.removeEventListener('pointerdown', releaseJump);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('mouseup', scheduleUpdate);
      window.removeEventListener('touchend', scheduleUpdate);
      resizeObserver?.disconnect();
    };
  }, [isActive, releaseJump, scheduleUpdate, scrollContainerRef]);

  // New rows, a widened window or a new list move the prompts without a scroll.
  useEffect(() => {
    scheduleUpdate();
  }, [entries, visibleMessages, scheduleUpdate]);

  // Reset as well as cancelled: a remount (StrictMode does one) must be able
  // to schedule again.
  useEffect(() => () => {
    if (frameRef.current) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    }
  }, []);

  // A jump belongs to the session it was made in. The view itself follows on
  // the next update, which the new session's prompts schedule.
  useEffect(() => {
    jumpTokenRef.current += 1;
    pinnedRef.current = null;
  }, [sessionId]);

  /* ---------------------------------------------------------------- */
  /*  The jump                                                         */
  /* ---------------------------------------------------------------- */

  /** Puts the row's top just under the sticky header and keeps it there while the rows around it settle. */
  const alignRow = useCallback((timestamp: string, token: number) => {
    const startedAt = performance.now();
    let flashed = false;

    const step = () => {
      if (jumpTokenRef.current !== token) {
        return;
      }
      const container = scrollContainerRef.current;
      if (!container) {
        return;
      }

      const row = findRenderedRow(container, timestamp);
      if (row) {
        const delta = row.getBoundingClientRect().top
          - container.getBoundingClientRect().top
          - readAlignOffset(container);
        if (Math.abs(delta) > 1) {
          container.scrollTop += delta;
        }
        if (!flashed) {
          flashed = flashPromptBubble(row);
        }
      }

      if (performance.now() - startedAt < ALIGN_DURATION_MS) {
        requestAnimationFrame(step);
      }
    };

    requestAnimationFrame(step);
  }, [scrollContainerRef]);

  const jumpTo = useCallback(async (index: number) => {
    const entry = latestRef.current.entries[index];
    const jumpSessionId = latestRef.current.sessionId;
    if (!entry) {
      return;
    }

    jumpTokenRef.current += 1;
    const token = jumpTokenRef.current;
    const isCurrent = () => jumpTokenRef.current === token && latestRef.current.sessionId === jumpSessionId;

    pinnedRef.current = index;
    setView({ active: index, midTurn: false });
    // Before anything loads: a row count change while the view still counts as
    // "at the bottom" would schedule a scroll back down.
    setIsUserScrolledUp(true);

    let messages = latestRef.current.chatMessages;
    let rowIndex = findLoadedPromptIndex(messages, entry);

    if (rowIndex < 0 && jumpSessionId) {
      setIsJumping(true);
      try {
        // Load the tail that reaches the prompt — not the whole transcript,
        // which on a long session is tens of megabytes over a phone link.
        // Rows appended since the list was read push the prompt further back.
        const slot = sessionStore.getSessionSlot(jumpSessionId);
        const loadedRows = slot?.serverMessages.length ?? 0;
        if (entry.fromEnd !== null) {
          const appendedSinceList = Math.max(0, (slot?.total ?? 0) - latestRef.current.listTotal);
          const limit = Math.max(
            entry.fromEnd + appendedSinceList + SESSION_MESSAGES_PAGE_SIZE,
            loadedRows + SESSION_MESSAGES_PAGE_SIZE,
          );
          await sessionStore.fetchFromServer(jumpSessionId, { limit, offset: 0, canRequest: isCurrent });
          messages = normalizedToChatMessages(sessionStore.getMessages(jumpSessionId));
          rowIndex = findLoadedPromptIndex(messages, entry);
        }

        // The position was off (the history was rewritten under it): read it all.
        if (rowIndex < 0 && isCurrent() && sessionStore.getSessionSlot(jumpSessionId)?.hasMore !== false) {
          await sessionStore.fetchFromServer(jumpSessionId, { limit: null, offset: 0, canRequest: isCurrent });
          messages = normalizedToChatMessages(sessionStore.getMessages(jumpSessionId));
          rowIndex = findLoadedPromptIndex(messages, entry);
        }
      } finally {
        // A newer jump in this session owns the flag; one in another session
        // never sees this one finish.
        if (jumpTokenRef.current === token || latestRef.current.sessionId !== jumpSessionId) {
          setIsJumping(false);
        }
      }
    }

    if (!isCurrent()) {
      return;
    }
    if (rowIndex < 0) {
      // The prompt is gone from the history (an edit cut it): nothing to show.
      pinnedRef.current = null;
      scheduleUpdate();
      return;
    }

    revealRowAt(messages.length, rowIndex);
    alignRow(String(messages[rowIndex].timestamp), token);
  }, [alignRow, revealRowAt, scheduleUpdate, sessionStore, setIsUserScrolledUp]);

  const step = useCallback((direction: -1 | 1) => {
    const { active, midTurn } = latestRef.current.view;
    if (direction < 0) {
      if (active >= 0) {
        void jumpTo(midTurn ? active : active - 1);
      }
      return;
    }
    void jumpTo(active + 1);
  }, [jumpTo]);

  const scrollTranscriptBy = useCallback((deltaY: number) => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }
    releaseJump();
    container.scrollTop += deltaY;
  }, [releaseJump, scrollContainerRef]);

  return {
    entries,
    activeIndex: view.active,
    canStepBack: view.active > 0 || (view.active === 0 && view.midTurn),
    canStepForward: view.active < entries.length - 1,
    isJumping,
    placement,
    jumpTo,
    step,
    scrollTranscriptBy,
  };
}
