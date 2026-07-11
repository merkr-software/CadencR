import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { VirtuosoHandle, FollowOutputCallback } from "react-virtuoso";
import type { AgentBlockData } from "../AgentBlock";
import { subscribeResize } from "@/lib/resize-coordinator";
import { isIos } from "@/lib/is-ios";
import { isAutoScrollPinSuppressed } from "@/lib/agent-scroll-suppression";
import {
  canScroll,
  MAX_VIEWPORT_FILL_PAGES,
  type HistoryAnchor,
  type UseAgentSessionScrollResult,
} from "./agent-session-scroll-utils";
import { useAgentSessionScrollInput } from "./useAgentSessionScrollInput";

/**
 * Auto-scroll for the chat, in three rules:
 *
 *   1. At the bottom → auto-scroll, always.
 *   2. User scrolls up → stop auto-scrolling.
 *   3. User clicks the chip → scroll to bottom (rule 1 re-engages).
 *
 * With virtualization, raw `scrollTop = scrollHeight` is stale as markdown,
 * code blocks, and query-backed blocks remeasure. Bottom-pinning is delegated
 * to react-virtuoso's measurement-aware APIs:
 *
 *   - `followOutput`: returns 'auto' while stick is engaged. Virtuoso re-runs
 *     it on every data change AND after async measurement settles, so the
 *     view stays pinned through markdown / code highlighting / query loads.
 *   - `atBottomStateChange`: Virtuoso's measurement-aware bottom detection.
 *     We use it to re-engage when the user lands at the bottom — we never
 *     disengage here, because async height settles must not flip stick off.
 *   - `scrollToIndex({ index: 'LAST', align: 'end' })`: the only correct way
 *     to programmatically reach the true last item; Virtuoso renders forward
 *     until it actually arrives. Used by the chip and conversation-switch.
 *
 * Disengage stays on user input so streaming re-anchors cannot undo it.
 */

interface UseAgentSessionScrollOptions {
  /**
   * Conversation contents. The hook reads `length` to detect the first
   * non-empty paint (so we can scroll to bottom once blocks arrive after
   * mount). Pass the same array `<AgentStream>` renders.
   */
  blocks: AgentBlockData[];
  /**
   * Identifier for the active conversation. When this changes, the hook
   * resets stick state to `true` and re-anchors to the bottom — the
   * `AgentSession` instance is reused across session switches, so without an
   * explicit reset, a "scrolled up" state from the previous conversation
   * would leak into the next one and the user would land mid-history.
   */
  conversationKey: string | null;
  hasMore?: boolean;
  /** Resolves with the number of prepended blocks (or `void`). */
  onLoadOlder?: () => Promise<number | void>;
}

export function useAgentSessionScroll({
  blocks,
  conversationKey,
  hasMore,
  onLoadOlder,
}: UseAgentSessionScrollOptions): UseAgentSessionScrollResult {
  const blocksLength = blocks.length;

  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const scrollerElRef = useRef<HTMLElement | null>(null);
  const stickRef = useRef(true);
  const historyLoadArmedRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const historyAnchorRef = useRef<HistoryAnchor | null>(null);
  const lastScrollTopRef = useRef(0);
  const suppressScrollIntentRef = useRef(false);
  const userScrollIntentRef = useRef(false);
  const prevConversationKeyRef = useRef<string | null>(conversationKey);
  // One-shot first-paint bottom pin; subsequent appends use `followOutput`.
  const didFirstPaintScrollRef = useRef(false);
  // Pages auto-prepended this conversation to fill an under-filled viewport.
  const viewportFillPagesRef = useRef(0);
  const [autoScrollEnabled, setAutoScrollEnabledState] = useState(true);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);

  // Stable Virtuoso handlers read current pagination state through refs.
  const hasMoreRef = useRef(hasMore);
  const onLoadOlderRef = useRef(onLoadOlder);
  hasMoreRef.current = hasMore;
  onLoadOlderRef.current = onLoadOlder;

  const setAutoScrollEnabled = useCallback((enabled: boolean): void => {
    if (stickRef.current === enabled) return;
    stickRef.current = enabled;
    setAutoScrollEnabledState(enabled);
  }, []);

  /**
   * `scrollToIndex({ index: 'LAST', align: 'end' })` is Virtuoso's
   * measurement-aware "go to the real bottom" — but when the last item is a
   * `CompactFlowRow` with flex-wrap content, the row's measured height lags
   * one frame behind the actual layout (a newly-appended tile can wrap to a
   * new line *after* Virtuoso reads the row's height). In that race the
   * align-end target ends up halfway through the last line. Direct-pinning
   * the scroller to its post-layout `scrollHeight` on the next frame closes
   * that gap — same end state, but uses the live DOM measurement Virtuoso's
   * one-shot align doesn't re-read.
   */
  const pinScrollerToEnd = useCallback((): void => {
    const el = scrollerElRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  const pinToEnd = useCallback((): void => {
    virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
    requestAnimationFrame(pinScrollerToEnd);
  }, [pinScrollerToEnd]);

  /**
   * The absolute-scrollTop restore below assumes the user holds still while a
   * history page loads — true for wheel scrolling, false for iOS momentum
   * scrolling. On iOS WebKit, Virtuoso routes upward-resize compensation
   * through a CSS "deviation" offset while a scroll is in flight and flushes
   * it as a single scrollBy once scrolling stops; writing
   * `anchor.scrollTop + delta` on top of that fights both the momentum (the
   * anchor is pre-momentum, so the view snaps back *down*) and the pending
   * deviation (double compensation). Skip the anchor entirely there —
   * `firstItemIndex` plus Virtuoso's iOS path own prepend anchoring.
   */
  const captureHistoryAnchor = useCallback((): void => {
    if (isIos()) return;
    const el = scrollerElRef.current;
    historyAnchorRef.current = el
      ? { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight }
      : null;
  }, []);

  const armUserScrollIntent = useCallback((): void => {
    userScrollIntentRef.current = true;
  }, []);

  const restoreHistoryAnchor = useCallback((): void => {
    const anchor = historyAnchorRef.current;
    const el = scrollerElRef.current;
    if (!anchor || !el || stickRef.current) return;

    const scrollHeightDelta = el.scrollHeight - anchor.scrollHeight;
    if (scrollHeightDelta <= 0) return;

    const targetScrollTop = anchor.scrollTop + scrollHeightDelta;
    if (Math.abs(el.scrollTop - targetScrollTop) <= 1) return;

    el.scrollTop = targetScrollTop;
    lastScrollTopRef.current = targetScrollTop;
  }, []);

  const scheduleHistoryAnchorRestore = useCallback((): void => {
    let frames = 0;
    const restoreFrame = (): void => {
      restoreHistoryAnchor();
      frames += 1;
      if (frames < 3) requestAnimationFrame(restoreFrame);
    };

    requestAnimationFrame(restoreFrame);
    window.setTimeout(() => {
      restoreHistoryAnchor();
      historyAnchorRef.current = null;
    }, 750);
  }, [restoreHistoryAnchor]);

  const requestOlderHistory = useCallback((): void => {
    if (!hasMoreRef.current || !onLoadOlderRef.current || loadingOlderRef.current) return;
    captureHistoryAnchor();
    const loadGeneration = loadGenerationRef.current;
    loadingOlderRef.current = true;
    setIsLoadingOlder(true);
    void onLoadOlderRef
      .current()
      .then(() => {
        if (loadGeneration !== loadGenerationRef.current) return;
        scheduleHistoryAnchorRestore();
        historyLoadArmedRef.current = false;
        userScrollIntentRef.current = false;
        loadingOlderRef.current = false;
        setIsLoadingOlder(false);
      })
      .catch(() => {
        if (loadGeneration !== loadGenerationRef.current) return;
        historyAnchorRef.current = null;
        historyLoadArmedRef.current = false;
        userScrollIntentRef.current = false;
        loadingOlderRef.current = false;
        setIsLoadingOlder(false);
        toast.error("Failed to load older messages");
      });
  }, [captureHistoryAnchor, scheduleHistoryAnchorRestore]);

  // Backfill older history when the initial (small) window doesn't fill the
  // viewport. Runs only while pinned to the bottom (stick engaged), so it
  // never competes with the user's own scroll-up history loads, and reuses the
  // same `requestOlderHistory` path — whose anchor-restore is a no-op while
  // stuck, leaving us pinned to the latest message as older blocks fill in
  // above. Driven by Virtuoso's measurement-aware height signal so we test the
  // real post-layout height, never a premature one. Self-terminates when a
  // scrollbar appears, history runs out, or the page cap is hit.
  const maybeFillViewport = useCallback((): void => {
    if (!stickRef.current || loadingOlderRef.current) return;
    if (!hasMoreRef.current || !onLoadOlderRef.current) return;
    if (viewportFillPagesRef.current >= MAX_VIEWPORT_FILL_PAGES) return;
    const el = scrollerElRef.current;
    if (!el || canScroll(el)) return;
    viewportFillPagesRef.current += 1;
    requestOlderHistory();
  }, [requestOlderHistory]);

  const resetHistoryLoadIntent = useCallback((): void => {
    historyLoadArmedRef.current = false;
    userScrollIntentRef.current = false;
    historyAnchorRef.current = null;
    lastScrollTopRef.current = scrollerElRef.current?.scrollTop ?? 0;
  }, []);

  const suppressProgrammaticScrollIntent = useCallback((): void => {
    suppressScrollIntentRef.current = true;
    requestAnimationFrame(() => {
      lastScrollTopRef.current = scrollerElRef.current?.scrollTop ?? lastScrollTopRef.current;
      suppressScrollIntentRef.current = false;
    });
  }, []);

  const scrollToBottom = useCallback((): void => {
    resetHistoryLoadIntent();
    setAutoScrollEnabled(true);
    pinToEnd();
  }, [resetHistoryLoadIntent, setAutoScrollEnabled, pinToEnd]);

  const followOutput = useCallback<FollowOutputCallback>(() => {
    // A recap expand/collapse animates row height; don't let its transient
    // growth re-pin the view (see `agent-scroll-suppression`).
    return stickRef.current && !isAutoScrollPinSuppressed() ? "auto" : false;
  }, []);

  const onAtBottomStateChange = useCallback(
    (atBottom: boolean): void => {
      if (!atBottom) return;
      const wasDisengaged = !stickRef.current;
      resetHistoryLoadIntent();
      setAutoScrollEnabled(true);
      if (!wasDisengaged) return;
      pinToEnd();
    },
    [resetHistoryLoadIntent, setAutoScrollEnabled, pinToEnd],
  );

  // The "opens almost at the bottom" gap on cold-open comes from Virtuoso
  // re-measuring items after the first paint: markdown highlighting, code
  // blocks, and any block whose final height differs from
  // `defaultItemHeight={96}` shift the total list height after we've already
  // scrolled. `totalListHeightChanged` is Virtuoso's measurement-aware signal
  // — fired once per height delta after items remeasure — so re-pinning here
  // catches every settle step until the list stabilises. Gated on
  // `stickRef.current` so it never fights older-history prepend (stick is
  // off when the user is scrolled up).
  const onTotalListHeightChanged = useCallback(
    (_height: number): void => {
      restoreHistoryAnchor();
      // Skip the bottom-pin while a recap toggle is animating its height — that
      // height delta is user-driven, not new content, so re-pinning would jump
      // the clicked recap out of view.
      if (!stickRef.current || isAutoScrollPinSuppressed()) return;
      pinToEnd();
      maybeFillViewport();
    },
    [restoreHistoryAnchor, pinToEnd, maybeFillViewport],
  );

  // Conversation switch: parent reuses this hook instance across sessionId
  // changes, so a "scrolled up" stick state would otherwise leak into the
  // next conversation. Reset to bottom + stick before any block-driven
  // re-anchor runs in the same commit. `scrollToIndex` is measurement-aware
  // — no manual `scrollTop` math, no swap-window timer needed.
  useLayoutEffect(() => {
    if (prevConversationKeyRef.current === conversationKey) return;
    prevConversationKeyRef.current = conversationKey;
    loadGenerationRef.current += 1;
    loadingOlderRef.current = false;
    stickRef.current = true;
    resetHistoryLoadIntent();
    setIsLoadingOlder(false);
    setAutoScrollEnabledState(true);
    didFirstPaintScrollRef.current = false;
    viewportFillPagesRef.current = 0;
    suppressProgrammaticScrollIntent();
    pinToEnd();
  }, [conversationKey, resetHistoryLoadIntent, suppressProgrammaticScrollIntent, pinToEnd]);

  // First-paint catch-up: when blocks arrive after mount (the common case for
  // opening an existing conversation), Virtuoso's `initialTopMostItemIndex`
  // is already past. Fire a single `scrollToIndex` on the first non-empty
  // paint so we land at the bottom; subsequent appends are owned by
  // `followOutput`.
  useEffect(() => {
    if (didFirstPaintScrollRef.current || blocksLength === 0) return;
    didFirstPaintScrollRef.current = true;
    if (!stickRef.current) return;
    pinToEnd();
  }, [blocksLength, pinToEnd]);

  // Catch up after a panel-resize drag ends. The RO callback skips work
  // while `isResizing()` is true (per the global rule in
  // `lib/resize-coordinator.ts`), so the moment the drag ends we run a
  // single re-anchor pass via Virtuoso so it accounts for measurement.
  useEffect(
    () =>
      subscribeResize((active) => {
        if (active || !stickRef.current) return;
        pinToEnd();
      }),
    [pinToEnd],
  );

  // Raw DOM input listeners (wheel / pointer / key / touch / scroll) that
  // disengage bottom-stick and arm history loading live in a sibling hook to
  // keep this file under the 400-line cap. It owns the scroller-element wiring
  // and returns the container ref callback.
  const scrollContainerRef = useAgentSessionScrollInput({
    scrollerElRef,
    historyLoadArmedRef,
    lastScrollTopRef,
    userScrollIntentRef,
    suppressScrollIntentRef,
    armUserScrollIntent,
    setAutoScrollEnabled,
    requestOlderHistory,
  });

  const onStartReached = useCallback((): void => {
    if (!historyLoadArmedRef.current) return;
    requestOlderHistory();
  }, [requestOlderHistory]);

  return {
    virtuosoRef,
    scrollContainerRef,
    onStartReached,
    followOutput,
    onAtBottomStateChange,
    onTotalListHeightChanged,
    autoScrollEnabled,
    isLoadingOlder,
    scrollToBottom,
  };
}
