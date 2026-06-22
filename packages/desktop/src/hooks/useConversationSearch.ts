import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import type { DisplayItem } from "@/components/agentStreamDisplay";
import {
  computeConversationMatches,
  type ConversationMatch,
} from "@/lib/conversation-search/matches";
import {
  clearConversationHighlights,
  paintConversationHighlights,
  scrollActiveMatchIntoView,
} from "@/lib/conversation-search/highlight";
import { useDebouncedValue } from "./useDebouncedValue";

const SEARCH_DEBOUNCE_MS = 100;
// Far off-screen jumps need a few frames for Virtuoso to mount the row and
// settle variable row heights; we re-center the occurrence on each frame.
const REPAINT_FRAMES = 8;
const NO_MATCHES: ConversationMatch[] = [];

export interface ConversationSearchState {
  isOpen: boolean;
  query: string;
  matchCount: number;
  /** 1-based index of the active match for display, or 0 when there are none. */
  activeNumber: number;
  /** Bumped on every (re)open so the input can refocus + select. */
  focusNonce: number;
  setQuery: (next: string) => void;
  openSearch: () => void;
  closeSearch: () => void;
  next: () => void;
  prev: () => void;
}

interface UseConversationSearchArgs {
  items: readonly DisplayItem[];
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  scrollerRef: RefObject<HTMLElement | null>;
}

interface PaintArgs {
  scrollerRef: RefObject<HTMLElement | null>;
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  isOpen: boolean;
  query: string;
  matches: ConversationMatch[];
  activeIndex: number;
}

/**
 * Paints search highlights over the virtualized stream and keeps the active
 * match scrolled into view. Highlighting is DOM-driven (only visible rows can
 * be painted), so we repaint on scroll and across the frames Virtuoso needs to
 * mount a freshly-targeted off-screen row.
 */
function usePaintConversationMatches({
  scrollerRef,
  virtuosoRef,
  isOpen,
  query,
  matches,
  activeIndex,
}: PaintArgs): void {
  const activeMatch = matches[activeIndex] ?? null;
  const stateRef = useRef({ isOpen, query, activeMatch });
  stateRef.current = { isOpen, query, activeMatch };

  const repaint = useCallback((): void => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const { isOpen: open, query: q, activeMatch: active } = stateRef.current;
    paintConversationHighlights(scroller, open ? q : "", active);
  }, [scrollerRef]);

  // Repaint on any state change that affects what should be highlighted. Keyed
  // on the match count (not the array) so a fresh `matches` identity on every
  // streaming chunk doesn't trigger a full repaint; scroll/navigation repaints
  // cover row recycling.
  useEffect(() => repaint(), [repaint, isOpen, query, matches.length, activeIndex]);

  // Bring the active match into view, then keep centering the exact occurrence
  // across the frames Virtuoso needs to mount the row and settle row heights.
  // `scrollToIndex` only positions the row — a block taller than the viewport
  // can still hide the occurrence, so we re-center its range every frame.
  const targetRow = activeMatch?.rowIndex ?? -1;
  const targetBlock = activeMatch?.blockId ?? "";
  const targetOcc = activeMatch?.occurrenceInBlock ?? -1;
  useEffect(() => {
    if (!isOpen || targetRow < 0) return;
    const scroller = scrollerRef.current;
    const rowMounted = scroller?.querySelector(`[data-block-id="${CSS.escape(targetBlock)}"]`);
    if (!rowMounted) {
      virtuosoRef.current?.scrollToIndex({ index: targetRow, align: "center", behavior: "auto" });
    }
    // A mounted row only needs a frame to center the occurrence; mounting an
    // off-screen row takes several frames for Virtuoso to settle row heights.
    const frameTarget = rowMounted ? 2 : REPAINT_FRAMES;
    let frames = 0;
    let raf = requestAnimationFrame(function tick() {
      const el = scrollerRef.current;
      if (el) {
        scrollActiveMatchIntoView(el, stateRef.current.query, stateRef.current.activeMatch);
        repaint();
      }
      frames += 1;
      if (frames < frameTarget) raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [isOpen, targetRow, targetBlock, targetOcc, repaint, virtuosoRef, scrollerRef]);

  // Highlight ranges go stale as Virtuoso recycles rows — repaint on scroll.
  useEffect(() => {
    if (!isOpen) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let raf = 0;
    const onScroll = (): void => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        repaint();
      });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [isOpen, scrollerRef, repaint]);

  // Clear highlights if the bar unmounts (e.g. tab switch) without closing.
  useEffect(() => () => clearConversationHighlights(), []);
}

/**
 * Drives the in-conversation find bar. Matches are computed from the in-memory
 * transcript (so off-screen rows count and navigate), while highlighting is
 * delegated to {@link usePaintConversationMatches}.
 */
export function useConversationSearch({
  items,
  virtuosoRef,
  scrollerRef,
}: UseConversationSearchArgs): ConversationSearchState {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [focusNonce, setFocusNonce] = useState(0);

  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const matches = useMemo(
    () => (isOpen ? computeConversationMatches(items, debouncedQuery) : NO_MATCHES),
    [isOpen, items, debouncedQuery],
  );
  // Clamp at read time so a shrinking match set can't leave a stale index (or a
  // transient "4/3") — no extra effect needed.
  const activeNumber = matches.length === 0 ? 0 : Math.min(activeIndex, matches.length - 1) + 1;

  // New query → jump back to the first match.
  useEffect(() => setActiveIndex(0), [debouncedQuery]);

  usePaintConversationMatches({
    scrollerRef,
    virtuosoRef,
    isOpen,
    query: debouncedQuery,
    matches,
    activeIndex: activeNumber - 1,
  });

  const openSearch = useCallback((): void => {
    setIsOpen(true);
    setFocusNonce((n) => n + 1);
  }, []);
  const closeSearch = useCallback((): void => {
    setIsOpen(false);
    setQuery("");
    setActiveIndex(0);
    clearConversationHighlights();
  }, []);
  const step = useCallback(
    (delta: number): void => {
      const count = matches.length;
      if (count === 0) return;
      // `% count` keeps the index in range even if it was left stale by a shrink.
      setActiveIndex((i) => (i + delta + count) % count);
    },
    [matches.length],
  );
  const next = useCallback(() => step(1), [step]);
  const prev = useCallback(() => step(-1), [step]);

  return useMemo(
    () => ({
      isOpen,
      query,
      matchCount: matches.length,
      activeNumber,
      focusNonce,
      setQuery,
      openSearch,
      closeSearch,
      next,
      prev,
    }),
    [isOpen, query, matches.length, activeNumber, focusNonce, openSearch, closeSearch, next, prev],
  );
}
