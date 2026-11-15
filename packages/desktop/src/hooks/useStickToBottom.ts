import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  canScroll,
  isVerticalScrollbarPointer,
} from "@/components/agent-session/agent-session-scroll-utils";
import { isResizing } from "@/lib/resize-coordinator";
import { pinToBottom } from "@/lib/scroll-pin";

/** Distance from the bottom (px) still counted as "at the bottom". */
const BOTTOM_THRESHOLD_PX = 16;

export interface StickToBottomHandles {
  /** Attach to the scrollable container. */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** Attach to the inner content wrapper — observed for growth. */
  contentRef: React.RefObject<HTMLDivElement | null>;
  /** Whether auto-scroll is currently armed. */
  autoScroll: boolean;
  /** Toggle auto-scroll; enabling snaps back to the bottom. */
  toggle: () => void;
}

interface ScrollFollowingParams {
  active: boolean;
  autoScrollRef: RefObject<boolean>;
  contentRef: RefObject<HTMLDivElement | null>;
  disengage: () => void;
  lastScrollTopRef: RefObject<number>;
  pin: () => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  setAutoScroll: (active: boolean) => void;
  touchStartYRef: RefObject<number>;
  userIntentRef: RefObject<boolean>;
}

function useScrollFollowing({
  active,
  autoScrollRef,
  contentRef,
  disengage,
  lastScrollTopRef,
  pin,
  scrollRef,
  setAutoScroll,
  touchStartYRef,
  userIntentRef,
}: ScrollFollowingParams): void {
  useEffect(() => {
    const el = scrollRef.current;
    if (!active || !el) return;

    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY < 0 && canScroll(el)) disengage();
    };
    const onTouchStart = (event: TouchEvent): void => {
      touchStartYRef.current = event.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (event: TouchEvent): void => {
      const y = event.touches[0]?.clientY ?? 0;
      if (y > touchStartYRef.current + 5 && canScroll(el)) disengage();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home") disengage();
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (isVerticalScrollbarPointer(el, event) && canScroll(el)) userIntentRef.current = true;
    };
    const onScroll = (): void => {
      const top = el.scrollTop;
      const prev = lastScrollTopRef.current;
      lastScrollTopRef.current = top;
      const atBottom = el.scrollHeight - top - el.clientHeight < BOTTOM_THRESHOLD_PX;
      if (atBottom) {
        userIntentRef.current = false;
        if (!autoScrollRef.current) setAutoScroll(true);
        return;
      }
      if (userIntentRef.current && top < prev - 1 && autoScrollRef.current) setAutoScroll(false);
    };

    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("pointerdown", onPointerDown, { passive: true });
    el.addEventListener("scroll", onScroll, { passive: true });

    const content = contentRef.current;
    const observer =
      content && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            if (autoScrollRef.current && !isResizing()) pin();
          })
        : undefined;
    if (content) observer?.observe(content);
    if (autoScrollRef.current) pin();

    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, [
    active,
    autoScrollRef,
    contentRef,
    disengage,
    lastScrollTopRef,
    pin,
    scrollRef,
    setAutoScroll,
    touchStartYRef,
    userIntentRef,
  ]);
}

/**
 * Keep a plain scroll container pinned to the bottom while `active`, the way a
 * chat/log view follows new output.
 *
 * Two rules, both learned from the main agent stream's scroll hook:
 *
 *  - **Follow growth via `ResizeObserver`, not React deps.** A block can grow
 *    *after* it appears (streaming bash output, thinking tokens, async
 *    markdown/ANSI remeasure, collapse animations) without any change the
 *    render tree can key on. Observing the content box re-pins on every such
 *    height change so the view never drifts off the bottom.
 *  - **Disengage only on a real user gesture** (wheel-up, touch-drag,
 *    keyboard, scrollbar drag) — never on a bare `scroll` event. Browser
 *    scroll-anchoring and our own programmatic pin both fire `scroll`; treating
 *    those as "user scrolled up" is exactly what silently kills auto-scroll.
 *    Re-arms when the user returns to the bottom.
 */
export function useStickToBottom(active: boolean): StickToBottomHandles {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const autoScrollRef = useRef(true);
  autoScrollRef.current = autoScroll;
  // Set by an actual user input gesture; gates the `scroll` handler so reflow
  // and programmatic pins can't disengage.
  const userIntentRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const touchStartYRef = useRef(0);

  const pin = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    pinToBottom(el);
    lastScrollTopRef.current = el.scrollTop;
  }, []);

  const disengage = useCallback(() => {
    userIntentRef.current = true;
    setAutoScroll(false);
  }, []);

  const toggle = useCallback(() => {
    setAutoScroll((prev) => {
      const next = !prev;
      if (next) {
        userIntentRef.current = false;
        requestAnimationFrame(pin);
      }
      return next;
    });
  }, [pin]);

  useScrollFollowing({
    active,
    autoScrollRef,
    contentRef,
    disengage,
    lastScrollTopRef,
    pin,
    scrollRef,
    setAutoScroll,
    touchStartYRef,
    userIntentRef,
  });

  return { scrollRef, contentRef, autoScroll, toggle };
}
