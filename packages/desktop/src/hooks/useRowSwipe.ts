import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

/** Travel (px) before a drag reads as either a row swipe or a scroll. */
export const ROW_SWIPE_INTENT_PX = 10;
/** A drag is horizontal once its sideways travel beats its vertical one by this factor. */
const HORIZONTAL_RATIO = 1.5;
/** How far past the tray's width the row follows the finger, damped. */
const OVERSHOOT_PX = 24;
/** The click a released swipe would leave behind lands within this window. */
const CLICK_SUPPRESS_MS = 400;
/** The CSS variable the tray reveals itself by (`sidebar-phone.css`). */
const OFFSET_VAR = "--row-swipe-x";
/** The tray inside the row (`SidebarRowSwipeTray`): it receives the offset. */
export const ROW_SWIPE_TRAY_SELECTOR = "[data-row-swipe-tray]";

type Phase = "idle" | "pending" | "drag" | "scroll";

interface Gesture {
  phase: Phase;
  startX: number;
  startY: number;
  /** The tray's revealed width when the touch began: 0 closed, `trayWidth` open. */
  base: number;
  offset: number;
}

/** The one row whose tray is open, closed when another row starts a swipe. */
let openRowCloser: (() => void) | null = null;

export interface RowSwipe {
  open: boolean;
  setOpen: (open: boolean) => void;
}

function trayOf(row: HTMLElement): HTMLElement | null {
  const tray = row.querySelector(ROW_SWIPE_TRAY_SELECTOR);
  return tray instanceof HTMLElement ? tray : null;
}

/** Reveal `px` of the tray; 0 drops the variable (the stylesheet's default). */
function writeOffset(tray: HTMLElement, px: number): void {
  if (px > 0) tray.style.setProperty(OFFSET_VAR, `${px}px`);
  else if (tray.style.getPropertyValue(OFFSET_VAR)) tray.style.removeProperty(OFFSET_VAR);
}

/**
 * Swipe a sidebar row left to reveal its action tray (phone layout, touch). A
 * recognizer on passive listeners: it never cancels a touch, so a vertical
 * drag scrolls the list untouched (`touch-action: pan-y` on the row keeps the
 * browser off horizontal drags). The drag is claimed only once its travel is
 * clearly horizontal; from then on its moves stop at the row, so the drawer's
 * own swipe-to-close (`MobileDrawer`) never sees them. A long press is left
 * alone. While dragging, the offset is written straight to the tray's style:
 * no render per move. A release past half the tray opens it, else it closes; a
 * second finger settles the drag as a release would, a cancelled touch closes
 * it. The click the release may leave behind is swallowed, and a tap on an
 * open row outside its tray closes the tray instead of opening the
 * conversation.
 */
export function useRowSwipe({
  ref,
  enabled,
  trayWidth,
}: {
  /** The row element: it receives the touch listeners; its tray, the offset. */
  ref: RefObject<HTMLElement | null>;
  enabled: boolean;
  trayWidth: number;
}): RowSwipe {
  const [open, setOpenState] = useState(false);
  const openRef = useRef(open);
  const setOpen = useCallback((next: boolean) => {
    openRef.current = next;
    setOpenState(next);
  }, []);

  useEffect(() => {
    const el = ref.current;
    const tray = el && enabled ? trayOf(el) : null;
    if (!el || !tray) return;
    writeOffset(tray, open ? trayWidth : 0);
    if (!open) return;
    const close = (): void => setOpen(false);
    if (openRowCloser !== close) openRowCloser?.();
    openRowCloser = close;
    // A touch anywhere else closes the tray, as on iOS.
    const closeOnOutsideTouch = (event: TouchEvent): void => {
      if (event.target instanceof Node && el.contains(event.target)) return;
      close();
    };
    document.addEventListener("touchstart", closeOnOutsideTouch, { capture: true, passive: true });
    return () => {
      document.removeEventListener("touchstart", closeOnOutsideTouch, { capture: true });
      if (openRowCloser === close) openRowCloser = null;
    };
  }, [enabled, open, ref, setOpen, trayWidth]);

  useEffect((): (() => void) | void => {
    const el = ref.current;
    const tray = el && enabled ? trayOf(el) : null;
    if (!el || !tray) return;
    return attachSwipeListeners({ el, tray, trayWidth, openRef, setOpen });
  }, [enabled, ref, setOpen, trayWidth]);

  return useMemo(() => ({ open, setOpen }), [open, setOpen]);
}

interface SwipeTarget {
  el: HTMLElement;
  tray: HTMLElement;
  trayWidth: number;
  openRef: RefObject<boolean>;
  setOpen: (open: boolean) => void;
}

function attachSwipeListeners({ el, tray, trayWidth, openRef, setOpen }: SwipeTarget): () => void {
  const gesture: Gesture = { phase: "idle", startX: 0, startY: 0, base: 0, offset: 0 };
  let suppressClickUntil = 0;

  /** End a claimed drag on `next` (open or closed); anything else just idles. */
  const settle = (next: (offset: number) => boolean): void => {
    if (gesture.phase === "drag") {
      delete tray.dataset.dragging;
      suppressClickUntil = performance.now() + CLICK_SUPPRESS_MS;
      const open = next(gesture.offset);
      writeOffset(tray, open ? trayWidth : 0);
      setOpen(open);
    }
    gesture.phase = "idle";
  };
  const release = (): void => settle((offset) => offset >= trayWidth / 2);
  const cancel = (): void => settle(() => false);

  const onStart = (event: TouchEvent): void => {
    const touch = event.touches[0];
    if (!touch || event.touches.length > 1) {
      // A second finger: the drag so far settles as if lifted.
      release();
      return;
    }
    gesture.phase = "pending";
    gesture.startX = touch.clientX;
    gesture.startY = touch.clientY;
    gesture.base = openRef.current ? trayWidth : 0;
    gesture.offset = gesture.base;
  };

  const onMove = (event: TouchEvent): void => {
    if (event.touches.length > 1) {
      // A second finger landed elsewhere (another row): settle as if lifted.
      release();
      return;
    }
    const touch = event.touches[0];
    if (!touch || gesture.phase === "idle" || gesture.phase === "scroll") return;
    const dx = touch.clientX - gesture.startX;
    const dy = touch.clientY - gesture.startY;
    if (gesture.phase === "pending") {
      gesture.phase = classify(dx, dy, gesture.base);
      if (gesture.phase !== "drag") return;
      tray.dataset.dragging = "";
    }
    // Claimed: the drawer's swipe-to-close must not read this drag.
    event.stopPropagation();
    gesture.offset = dampedOffset(gesture.base - dx, trayWidth);
    writeOffset(tray, gesture.offset);
  };

  const onClickCapture = (event: MouseEvent): void => {
    // An action in the tray always runs, however soon after the swipe.
    if (event.target instanceof Node && tray.contains(event.target)) return;
    const leftBySwipe = performance.now() < suppressClickUntil;
    if (!leftBySwipe && !openRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    if (!leftBySwipe) setOpen(false);
  };

  el.addEventListener("touchstart", onStart, { passive: true });
  el.addEventListener("touchmove", onMove, { passive: true });
  el.addEventListener("touchend", release, { passive: true });
  el.addEventListener("touchcancel", cancel, { passive: true });
  el.addEventListener("click", onClickCapture, { capture: true });
  return () => {
    el.removeEventListener("touchstart", onStart);
    el.removeEventListener("touchmove", onMove);
    el.removeEventListener("touchend", release);
    el.removeEventListener("touchcancel", cancel);
    el.removeEventListener("click", onClickCapture, { capture: true });
    delete tray.dataset.dragging;
  };
}

/**
 * Decide a pending drag: a row swipe once its travel is clearly horizontal, a
 * scroll once it has gone the intent distance any other way, or not yet.
 */
export function classify(dx: number, dy: number, base: number): Phase {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax >= ROW_SWIPE_INTENT_PX && ax > ay * HORIZONTAL_RATIO) {
    // A closed row only opens leftwards: a rightward drag stays the drawer's.
    return base === 0 && dx > 0 ? "scroll" : "drag";
  }
  if (ay >= ROW_SWIPE_INTENT_PX) return "scroll";
  return "pending";
}

/** The finger's offset, held to the tray's width plus a damped overshoot. */
function dampedOffset(raw: number, trayWidth: number): number {
  if (raw <= 0) return 0;
  if (raw <= trayWidth) return raw;
  return trayWidth + Math.min(OVERSHOOT_PX, (raw - trayWidth) / 3);
}
