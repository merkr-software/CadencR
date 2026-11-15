import { useCallback, useRef } from "react";
import { isAutoScrollPinSuppressed } from "@/lib/agent-scroll-suppression";
import { isIos } from "@/lib/is-ios";
import { isResizing } from "@/lib/resize-coordinator";
import {
  canScrollStream,
  findStreamItemList,
  isVerticalScrollbarPointer,
  HISTORY_SCROLL_TOP_PX,
  type ScrollRef,
} from "./agent-session-scroll-utils";
import type { ScrollAnchorGuard } from "./stream-scroll-anchor";
import type { StreamScrollWriter } from "./stream-scroll-writer";

interface ScrollInputParams {
  scrollerElRef: React.MutableRefObject<HTMLElement | null>;
  /** Bottom-stick engaged? Read live so the height-pin observer respects it. */
  stickRef: React.MutableRefObject<boolean>;
  /** The stream's single scroll write point, attached before the guard. */
  writer: StreamScrollWriter;
  /** Attached to the scroller alongside the height-pin observer. */
  anchorGuard: Pick<ScrollAnchorGuard, "attach" | "detach">;
  historyLoadArmedRef: React.MutableRefObject<boolean>;
  lastScrollTopRef: React.MutableRefObject<number>;
  userScrollIntentRef: React.MutableRefObject<boolean>;
  suppressScrollIntentRef: React.MutableRefObject<boolean>;
  armUserScrollIntent: () => void;
  setAutoScrollEnabled: (enabled: boolean) => void;
  requestOlderHistory: () => void;
}

interface ScrollContainerRefParams {
  scrollerElRef: ScrollInputParams["scrollerElRef"];
  stickRef: ScrollInputParams["stickRef"];
  writer: ScrollInputParams["writer"];
  anchorGuard: ScrollInputParams["anchorGuard"];
  lastScrollTopRef: ScrollInputParams["lastScrollTopRef"];
  growthObserverRef: React.MutableRefObject<MutationObserver | null>;
  onKeyDown: (event: KeyboardEvent) => void;
  onPointerDown: (event: PointerEvent) => void;
  onWheel: (event: WheelEvent) => void;
  onScroll: () => void;
  onTouchStart: (event: TouchEvent) => void;
  onTouchMove: (event: TouchEvent) => void;
}

/**
 * Virtuoso's `scrollerRef`. Its identity must hold across renders, so every
 * handler it closes over is stable: Virtuoso re-runs its ref effect when it
 * changes, detaching and re-attaching every listener and observer — and
 * dropping the anchor guard's bridge mid-frame.
 */
function useScrollContainerRef({
  scrollerElRef,
  stickRef,
  writer,
  anchorGuard,
  lastScrollTopRef,
  growthObserverRef,
  onKeyDown,
  onPointerDown,
  onWheel,
  onScroll,
  onTouchStart,
  onTouchMove,
}: ScrollContainerRefParams): ScrollRef {
  return useCallback<ScrollRef>(
    (element) => {
      const previous = scrollerElRef.current;
      if (previous === element) return;
      if (previous) {
        previous.removeEventListener("keydown", onKeyDown);
        previous.removeEventListener("pointerdown", onPointerDown);
        previous.removeEventListener("wheel", onWheel);
        previous.removeEventListener("scroll", onScroll);
        previous.removeEventListener("touchstart", onTouchStart);
        previous.removeEventListener("touchmove", onTouchMove);
      }
      growthObserverRef.current?.disconnect();
      growthObserverRef.current = null;
      anchorGuard.detach();
      writer.detach();
      scrollerElRef.current = element;
      if (element) {
        lastScrollTopRef.current = element.scrollTop;
        element.addEventListener("keydown", onKeyDown);
        element.addEventListener("pointerdown", onPointerDown, { passive: true });
        element.addEventListener("wheel", onWheel, { passive: true });
        element.addEventListener("scroll", onScroll, { passive: true });
        element.addEventListener("touchstart", onTouchStart, { passive: true });
        element.addEventListener("touchmove", onTouchMove, { passive: true });
        writer.attach(element);
        observeListGrowth(element, stickRef, writer, growthObserverRef);
        anchorGuard.attach(element, writer);
      }
    },
    [
      anchorGuard,
      growthObserverRef,
      lastScrollTopRef,
      onKeyDown,
      onPointerDown,
      onScroll,
      onTouchMove,
      onTouchStart,
      onWheel,
      scrollerElRef,
      stickRef,
      writer,
    ],
  );
}

/**
 * Owns the raw DOM input listeners that disengage bottom-stick and arm
 * history loading. Split out of `useAgentSessionScroll` to keep that file
 * under the 400-line cap. Synchronous `wheel`/`touchmove`-up disengage fires
 * before the browser repaints, so a streaming-token re-anchor in the same
 * commit can't undo the user's scroll. We only disengage when the viewport
 * can actually scroll — wheel-up on a short session is idle intent, not a
 * request to leave the bottom.
 */
export function useAgentSessionScrollInput({
  scrollerElRef,
  stickRef,
  writer,
  anchorGuard,
  historyLoadArmedRef,
  lastScrollTopRef,
  userScrollIntentRef,
  suppressScrollIntentRef,
  armUserScrollIntent,
  setAutoScrollEnabled,
  requestOlderHistory,
}: ScrollInputParams): ScrollRef {
  const touchStartYRef = useRef(0);
  const growthObserverRef = useRef<MutationObserver | null>(null);

  const onWheel = useCallback(
    (e: WheelEvent): void => {
      if (e.deltaY >= 0) return;
      const el = scrollerElRef.current;
      if (!el || !canScrollStream(el)) return;
      armUserScrollIntent();
      historyLoadArmedRef.current = true;
      setAutoScrollEnabled(false);
    },
    [scrollerElRef, historyLoadArmedRef, armUserScrollIntent, setAutoScrollEnabled],
  );
  const onPointerDown = useCallback(
    (e: PointerEvent): void => {
      const el = scrollerElRef.current;
      if (!el || !canScrollStream(el) || !isVerticalScrollbarPointer(el, e)) return;
      historyLoadArmedRef.current = true;
      armUserScrollIntent();
    },
    [scrollerElRef, historyLoadArmedRef, armUserScrollIntent],
  );
  const onKeyDown = useCallback(
    (e: KeyboardEvent): void => {
      if (!["ArrowUp", "PageUp", "Home"].includes(e.key)) return;
      armUserScrollIntent();
    },
    [armUserScrollIntent],
  );
  const onTouchStart = useCallback((e: TouchEvent): void => {
    touchStartYRef.current = e.touches[0]?.clientY ?? 0;
  }, []);
  const onTouchMove = useCallback(
    (e: TouchEvent): void => {
      const y = e.touches[0]?.clientY ?? 0;
      if (y <= touchStartYRef.current + 5) return;
      const el = scrollerElRef.current;
      if (!el || !canScrollStream(el)) return;
      armUserScrollIntent();
      historyLoadArmedRef.current = true;
      setAutoScrollEnabled(false);
    },
    [scrollerElRef, historyLoadArmedRef, armUserScrollIntent, setAutoScrollEnabled],
  );
  const onScroll = useCallback((): void => {
    const el = scrollerElRef.current;
    if (!el) return;
    const currentScrollTop = el.scrollTop;
    const previousScrollTop = lastScrollTopRef.current;
    lastScrollTopRef.current = currentScrollTop;

    if (suppressScrollIntentRef.current || !canScrollStream(el)) return;
    if (!userScrollIntentRef.current) return;
    const isScrollingUp = currentScrollTop < previousScrollTop - 1;
    if (!isScrollingUp) return;

    historyLoadArmedRef.current = true;
    setAutoScrollEnabled(false);
    if (currentScrollTop <= HISTORY_SCROLL_TOP_PX) requestOlderHistory();
  }, [
    scrollerElRef,
    lastScrollTopRef,
    suppressScrollIntentRef,
    userScrollIntentRef,
    historyLoadArmedRef,
    requestOlderHistory,
    setAutoScrollEnabled,
  ]);

  return useScrollContainerRef({
    scrollerElRef,
    stickRef,
    writer,
    anchorGuard,
    lastScrollTopRef,
    growthObserverRef,
    onKeyDown,
    onPointerDown,
    onWheel,
    onScroll,
    onTouchStart,
    onTouchMove,
  });
}

/**
 * Glue the view to the bottom in the SAME frame the conversation grows.
 *
 * When the agent streams a new line, React commits the taller DOM but
 * react-virtuoso's `followOutput` only re-pins `scrollTop` on the *next*
 * frame, so the growth frame paints with the new content pushed below the
 * fold — a visible one-frame "jump down, then up" on the trailing "Working…"
 * cursor and any not-yet-received message. A `ResizeObserver` can't fix it:
 * its callback for the growth is delivered a frame late, after the bad frame
 * has already painted (measured: gap still spikes ~86px). A `MutationObserver`
 * fires as a microtask right after the DOM mutation — before layout and paint
 * — so pinning `scrollTop` there closes the gap in the same frame the content
 * grows. MutationObserver coalesces a commit's mutations into one callback, so
 * this reads layout once per streamed chunk, not per character.
 *
 * Only pins while bottom-stick is engaged, not suppressed (recap-toggle height
 * animations), and not mid split-pane resize (the `resize-coordinator` owns
 * scroll during a drag), so it never fights a scrolled-up reader or a resize.
 * Degrades to the (one-frame-late) `followOutput` behaviour if Virtuoso's DOM
 * contract changes and the item list can't be found.
 *
 * ## Never on iOS
 *
 * Writing an absolute `scrollTop` fights Virtuoso's iOS path, which corrects
 * position through a CSS "deviation" offset instead of a direct scroll (the
 * same reason `ScrollAnchorGuard` skips iOS). The two form a closed loop:
 * our write emits a `scroll` event → Virtuoso re-renders and re-applies its
 * correction → that commit mutates the observed list → the observer fires and
 * we write again. It never converges, because the list's height oscillates
 * between the two states, so no value-comparison guard can break it. Left
 * running it pegs the main thread and eventually trips React's nested-update
 * guard (error #185). `followOutput` keeps iOS pinned, one frame later.
 */
function observeListGrowth(
  scroller: HTMLElement,
  stickRef: React.MutableRefObject<boolean>,
  writer: Pick<StreamScrollWriter, "pinToBottom">,
  observerRef: React.MutableRefObject<MutationObserver | null>,
): void {
  if (isIos()) return;
  const list = findStreamItemList(scroller);
  if (!list) return;
  let lastScrollHeight = scroller.scrollHeight;
  const observer = new MutationObserver(() => {
    // Cheap guards before any geometry: this fires on every mutation batch, and
    // reading `scrollHeight` forces a synchronous layout of the whole
    // transcript. A reader who scrolled up during a stream hits this path ~10
    // times a second and must not pay for it. Bailing before the read also
    // leaves `lastScrollHeight` behind, so growth that lands mid-suppression is
    // still pending and the first eligible mutation catches up.
    if (!stickRef.current || isAutoScrollPinSuppressed() || isResizing()) return;
    // Growth is the only thing worth re-pinning for. Reacting to every mutation
    // instead would fight a scroll that has not disengaged bottom-stick yet —
    // Virtuoso re-renders on scroll, and that re-render is itself a mutation.
    const scrollHeight = scroller.scrollHeight;
    const grew = scrollHeight > lastScrollHeight;
    lastScrollHeight = scrollHeight;
    if (!grew) return;
    writer.pinToBottom();
  });
  observer.observe(list, { childList: true, subtree: true, characterData: true });
  observerRef.current = observer;
}
