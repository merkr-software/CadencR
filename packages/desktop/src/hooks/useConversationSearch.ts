import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import type { AgentBlockData } from "@/types/agent-block";
import type { DisplayItem } from "@/types/agent-stream";
import {
  ConversationSearchIndex,
  ConversationSearchSnapshot,
} from "@/lib/conversation-search/incremental-index";
import type { ConversationMatch } from "@/lib/conversation-search/matches";
import {
  clearConversationHighlights,
  paintConversationHighlights,
  scrollActiveMatchIntoView,
} from "@/lib/conversation-search/highlight";
import { useDebouncedValue } from "./useDebouncedValue";
import { useConversationSearchNavigation } from "./useConversationSearchNavigation";

const SEARCH_DEBOUNCE_MS = 100;
// Far off-screen jumps need a few frames for Virtuoso to mount the row and
// settle variable row heights; we re-center the occurrence on each frame.
const REPAINT_FRAMES = 8;

export interface ConversationSearchState {
  isOpen: boolean;
  query: string;
  matchCount: number;
  /** 1-based index of the active match for display, or 0 when there are none. */
  activeNumber: number;
  /** Bumped on every (re)open so the input can refocus + select. */
  focusNonce: number;
  /** Block holding the active match while the bar is open, so a folded row can unfold. */
  activeBlockId: string | null;
  setQuery: (next: string) => void;
  openSearch: () => void;
  closeSearch: () => void;
  next: () => void;
  prev: () => void;
}

interface UseConversationSearchArgs {
  items: readonly DisplayItem[];
  /**
   * Paired tool results, so Bash rows are searched on the same output they
   * render. Completed commands keep their output only on the result row — see
   * `blockSearchableText` in `lib/conversation-search/matches`.
   */
  toolResultMap?: ReadonlyMap<string, AgentBlockData>;
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  scrollerRef: RefObject<HTMLElement | null>;
}

interface PaintArgs {
  scrollerRef: RefObject<HTMLElement | null>;
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  isOpen: boolean;
  query: string;
  matchCount: number;
  activeMatch: ConversationMatch | null;
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
  matchCount,
  activeMatch,
}: PaintArgs): void {
  const stateRef = useRef({ isOpen, query, activeMatch });
  stateRef.current = { isOpen, query, activeMatch };
  const targetRow = activeMatch?.rowIndex ?? -1;
  const targetBlock = activeMatch?.blockId ?? "";
  const targetOcc = activeMatch?.occurrenceInBlock ?? -1;

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
  useEffect(
    () => repaint(),
    [repaint, isOpen, query, matchCount, targetRow, targetBlock, targetOcc],
  );

  // Bring the active match into view, then keep centering the exact occurrence
  // across the frames Virtuoso needs to mount the row and settle row heights.
  // `scrollToIndex` only positions the row — a block taller than the viewport
  // can still hide the occurrence, so we re-center its range every frame.
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
  toolResultMap,
  virtuosoRef,
  scrollerRef,
}: UseConversationSearchArgs): ConversationSearchState {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [focusNonce, setFocusNonce] = useState(0);
  const searchIndexRef = useRef<ConversationSearchIndex | null>(null);
  if (!searchIndexRef.current) searchIndexRef.current = new ConversationSearchIndex();
  const searchIndex = searchIndexRef.current;

  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const snapshot = useMemo(
    () =>
      isOpen
        ? searchIndex.update(items, debouncedQuery, toolResultMap)
        : ConversationSearchSnapshot.empty,
    [isOpen, items, debouncedQuery, toolResultMap, searchIndex],
  );
  const { activeMatch, activeNumber, next, prev, reset } = useConversationSearchNavigation(
    snapshot,
    debouncedQuery,
  );

  usePaintConversationMatches({
    scrollerRef,
    virtuosoRef,
    isOpen,
    query: debouncedQuery,
    matchCount: snapshot.matchCount,
    activeMatch,
  });

  useEffect(() => () => searchIndex.clear(), [searchIndex]);

  const openSearch = useCallback((): void => {
    setIsOpen(true);
    setFocusNonce((n) => n + 1);
  }, []);
  const closeSearch = useCallback((): void => {
    setIsOpen(false);
    setQuery("");
    reset();
    searchIndex.clear();
    clearConversationHighlights();
  }, [reset, searchIndex]);

  const activeBlockId = isOpen ? (activeMatch?.blockId ?? null) : null;
  return useMemo(
    () => ({
      isOpen,
      query,
      matchCount: snapshot.matchCount,
      activeNumber,
      focusNonce,
      activeBlockId,
      setQuery,
      openSearch,
      closeSearch,
      next,
      prev,
    }),
    [
      isOpen,
      query,
      snapshot.matchCount,
      activeNumber,
      focusNonce,
      activeBlockId,
      openSearch,
      closeSearch,
      next,
      prev,
    ],
  );
}
