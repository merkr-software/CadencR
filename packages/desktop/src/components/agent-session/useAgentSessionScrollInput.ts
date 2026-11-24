import { useCallback, useRef } from "react";
import {
  useWorkspaceActivity,
  type WorkspaceActivity,
} from "@/components/workspace-pool/workspace-activity";
import { isAutoScrollPinSuppressed } from "@/lib/agent-scroll-suppression";
import { isIos } from "@/lib/is-ios";
import { isResizing } from "@/lib/resize-coordinator";
import {
  canScrollStream,
  findStreamItemList,
  isVerticalScrollbarPointer,
  type ScrollRef,
  USER_SCROLL_EVENTS,
} from "./agent-session-scroll-utils";
import { observeResizeSettle } from "./stream-resize-settle";
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
  lastScrollTopRef: React.MutableRefObject<number>;
  userScrollIntentRef: React.MutableRefObject<boolean>;
  suppressScrollIntentRef: React.MutableRefObject<boolean>;
  setAutoScrollEnabled: (enabled: boolean) => void;
  /** Any scroll of the transcript: a history gap may have come near the view. */
  onScrollActivity: () => void;
  /** The reader's own input (wheel, touch, pointer, key) reached the transcript. */
  onUserInput: () => void;
  /** Pins to the bottom the platform's way: the resize settle's re-pin. Identity-stable. */
  pinToEnd: () => void;
}

interface Disconnectable {
  disconnect: () => void;
}

interface ScrollContainerRefParams {
  scrollerElRef: ScrollInputParams["scrollerElRef"];
  stickRef: ScrollInputParams["stickRef"];
  writer: ScrollInputParams["writer"];
  anchorGuard: ScrollInputParams["anchorGuard"];
  lastScrollTopRef: ScrollInputParams["lastScrollTopRef"];
  growthObserverRef: React.MutableRefObject<Disconnectable | null>;
  onUserInput: () => void;
  pinToEnd: () => void;
  activity: WorkspaceActivity;
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
  onUserInput,
  pinToEnd,
  activity,
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
        for (const type of USER_SCROLL_EVENTS) previous.removeEventListener(type, onUserInput);
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
        for (const type of USER_SCROLL_EVENTS) {
          element.addEventListener(type, onUserInput, { passive: true });
        }
        writer.attach(element);
        growthObserverRef.current = observeStreamViewport(element, {
          stickRef,
          writer,
          pinToEnd,
          activity,
        });
        anchorGuard.attach(element, writer);
      }
    },
    [
      activity,
      anchorGuard,
      growthObserverRef,
      lastScrollTopRef,
      onKeyDown,
      onPointerDown,
      onScroll,
      onTouchMove,
      onTouchStart,
      onUserInput,
      onWheel,
      pinToEnd,
      scrollerElRef,
      stickRef,
      writer,
    ],
  );
}

/**
 * Everything that keeps the view in place as the transcript or its viewport
 * changes: off iOS the growth and viewport-shrink pins; on iOS, where those
 * cannot run, the resize settle (`observeResizeSettle`), so a rotation or a
 * fold keeps a pinned transcript pinned and a scrolled-up one on its row.
 */
function observeStreamViewport(
  scroller: HTMLElement,
  {
    stickRef,
    writer,
    pinToEnd,
    activity,
  }: {
    stickRef: React.MutableRefObject<boolean>;
    writer: StreamScrollWriter;
    pinToEnd: () => void;
    /** A hidden workspace's resize settle stands down. */
    activity: WorkspaceActivity;
  },
): Disconnectable {
  if (!isIos()) return observeListGrowth(scroller, stickRef, writer);
  return observeResizeSettle(scroller, {
    isFollowing: () => stickRef.current,
    pinToEnd,
    writer,
    isActive: activity.isActive,
  });
}

/**
 * Owns the raw DOM input listeners that disengage bottom-stick and wake the
 * history gap filler. Split out of `useAgentSessionScroll` to keep that file
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
  lastScrollTopRef,
  userScrollIntentRef,
  suppressScrollIntentRef,
  setAutoScrollEnabled,
  onScrollActivity,
  onUserInput,
  pinToEnd,
}: ScrollInputParams): ScrollRef {
  const touchStartYRef = useRef(0);
  const growthObserverRef = useRef<Disconnectable | null>(null);
  const activity = useWorkspaceActivity();
  const armUserScrollIntent = useCallback((): void => {
    userScrollIntentRef.current = true;
  }, [userScrollIntentRef]);

  const onWheel = useCallback(
    (e: WheelEvent): void => {
      if (e.deltaY >= 0) return;
      const el = scrollerElRef.current;
      if (!el || !canScrollStream(el)) return;
      armUserScrollIntent();
      setAutoScrollEnabled(false);
    },
    [scrollerElRef, armUserScrollIntent, setAutoScrollEnabled],
  );
  const onPointerDown = useCallback(
    (e: PointerEvent): void => {
      const el = scrollerElRef.current;
      if (!el || !canScrollStream(el) || !isVerticalScrollbarPointer(el, e)) return;
      armUserScrollIntent();
    },
    [scrollerElRef, armUserScrollIntent],
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
      setAutoScrollEnabled(false);
    },
    [scrollerElRef, armUserScrollIntent, setAutoScrollEnabled],
  );
  const onScroll = useCallback((): void => {
    const el = scrollerElRef.current;
    if (!el) return;
    onScrollActivity();
    const currentScrollTop = el.scrollTop;
    const previousScrollTop = lastScrollTopRef.current;
    lastScrollTopRef.current = currentScrollTop;

    if (suppressScrollIntentRef.current || !canScrollStream(el)) return;
    if (!userScrollIntentRef.current) return;
    const isScrollingUp = currentScrollTop < previousScrollTop - 1;
    if (isScrollingUp) setAutoScrollEnabled(false);
  }, [
    scrollerElRef,
    lastScrollTopRef,
    onScrollActivity,
    suppressScrollIntentRef,
    userScrollIntentRef,
    setAutoScrollEnabled,
  ]);

  return useScrollContainerRef({
    scrollerElRef,
    stickRef,
    writer,
    anchorGuard,
    lastScrollTopRef,
    growthObserverRef,
    onUserInput,
    pinToEnd,
    activity,
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
 * When the agent streams a new line, React commits the taller DOM, but a pin
 * from Virtuoso's own callbacks (its measurement runs in the next animation
 * frame) only lands on the *next* frame, so the growth frame paints with the
 * new content pushed below the fold — a visible one-frame "jump down, then up"
 * on the trailing "Working…" cursor and any not-yet-received message. A `ResizeObserver` can't fix it:
 * its callback for the growth is delivered a frame late, after the bad frame
 * has already painted (measured: gap still spikes ~86px). A `MutationObserver`
 * fires as a microtask right after the DOM mutation — before layout and paint
 * — so pinning `scrollTop` there closes the gap in the same frame the content
 * grows. MutationObserver coalesces a commit's mutations into one callback, so
 * this reads layout once per streamed chunk, not per character. The pin goes
 * through `followBottom`, which glides the rows up when animations are on.
 *
 * Only pins while bottom-stick is engaged, not suppressed (recap-toggle height
 * animations), and not mid split-pane resize (the `resize-coordinator` owns
 * scroll during a drag), so it never fights a scrolled-up reader or a resize.
 * Degrades to the (one-frame-late) `onTotalListHeightChanged` pin if
 * Virtuoso's DOM contract changes and the item list can't be found; the
 * viewport-shrink pin does not depend on it.
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
 * guard (error #185). `followOutput` keeps iOS pinned, one frame later, and
 * `observeStreamViewport` runs the resize settle there instead of this.
 */
function observeListGrowth(
  scroller: HTMLElement,
  stickRef: React.MutableRefObject<boolean>,
  writer: Pick<StreamScrollWriter, "followBottom" | "pinToBottom">,
): Disconnectable {
  const mayPin = (): boolean => stickRef.current && !isAutoScrollPinSuppressed() && !isResizing();
  const viewportObserver = observeViewportShrink(scroller, mayPin, writer);
  const list = findStreamItemList(scroller);
  if (!list) return viewportObserver;
  let lastScrollHeight = scroller.scrollHeight;
  // Virtuoso's footer wrapper, holding the working cursor and its timer. It
  // sits beside the list, so it is observed too: the cursor appearing at turn
  // start grows the transcript without touching a row.
  const footer = list.nextElementSibling instanceof HTMLElement ? list.nextElementSibling : null;
  let lastFooterHeight = footer?.offsetHeight ?? 0;
  const observer = new MutationObserver(() => {
    // Cheap guards before any geometry: this fires on every mutation batch, and
    // reading `scrollHeight` forces a synchronous layout of the whole
    // transcript. A reader who scrolled up during a stream hits this path ~10
    // times a second and must not pay for it. Bailing before the read also
    // leaves `lastScrollHeight` behind, so growth that lands mid-suppression is
    // still pending and the first eligible mutation catches up.
    if (!mayPin()) return;
    // Growth is the only thing worth re-pinning for. Reacting to every mutation
    // instead would fight a scroll that has not disengaged bottom-stick yet —
    // Virtuoso re-renders on scroll, and that re-render is itself a mutation.
    const scrollHeight = scroller.scrollHeight;
    const grew = scrollHeight > lastScrollHeight;
    lastScrollHeight = scrollHeight;
    const footerHeight = footer?.offsetHeight ?? 0;
    const footerGrew = footerHeight > lastFooterHeight;
    lastFooterHeight = footerHeight;
    if (!grew) return;
    // The footer grows in place, under the rows: gliding the rows down over
    // it would clip the end of the message the cursor just appeared under.
    if (footerGrew) writer.pinToBottom();
    else writer.followBottom();
  });
  const observed = { childList: true, subtree: true, characterData: true };
  observer.observe(list, observed);
  if (footer) observer.observe(footer, observed);
  return {
    disconnect: () => {
      observer.disconnect();
      viewportObserver.disconnect();
    },
  };
}

/**
 * The viewport shrinking (the composer growing a line) hides the bottom
 * without any list mutation, and Virtuoso no longer follows that off iOS (see
 * `followOutput`), so re-pin here. A growing viewport is clamped to the bottom
 * by the browser on its own. A shrink that lands while pins stand down stays
 * pending, like the growth observer's, and the next eligible resize catches up.
 */
function observeViewportShrink(
  scroller: HTMLElement,
  mayPin: () => boolean,
  writer: Pick<StreamScrollWriter, "pinToBottom">,
): Disconnectable {
  let lastViewport = scroller.clientHeight;
  let shrinkPending = false;
  const observer = new ResizeObserver(() => {
    const viewport = scroller.clientHeight;
    if (viewport < lastViewport) shrinkPending = true;
    lastViewport = viewport;
    if (!shrinkPending || !mayPin()) return;
    shrinkPending = false;
    writer.pinToBottom();
  });
  observer.observe(scroller);
  return observer;
}
