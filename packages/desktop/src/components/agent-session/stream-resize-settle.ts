import { isAutoScrollPinSuppressed } from "@/lib/agent-scroll-suppression";
import {
  findStreamItemList,
  readerFocusRow,
  USER_SCROLL_EVENTS,
} from "./agent-session-scroll-utils";
import type { StreamScrollWriter } from "./stream-scroll-writer";

/** Quiet time after the last resize before the view is put back. */
export const RESIZE_SETTLE_MS = 200;
/** Quiet time after the last scroll before the reader's row is read again. */
export const ANCHOR_IDLE_MS = 150;
/**
 * A finger counts as down only this long after its last touch event: a row
 * replaced under the finger (a streaming row's key swap) fires its touchend on
 * a detached node that never reaches the scroller.
 */
export const TOUCH_STALE_MS = 1000;

interface ResizeSettleOptions {
  /** Bottom-stick engaged. */
  isFollowing: () => boolean;
  /** Pins to the bottom the platform's way (an index scroll on iOS). */
  pinToEnd: () => void;
  writer: Pick<StreamScrollWriter, "scrollBy" | "indexScrollSettlesIn" | "jumpedSince">;
  /** The workspace is on screen (`useWorkspaceActivity`): a hidden one stands down. */
  isActive: () => boolean;
}

interface ReaderAnchor {
  row: Element;
  /** Its top edge, from the scroller's top edge. */
  top: number;
}

function readAnchor(scroller: HTMLElement): ReaderAnchor | null {
  const list = findStreamItemList(scroller);
  if (!list) return null;
  const box = scroller.getBoundingClientRect();
  const focus = readerFocusRow(list, box.top, box.bottom);
  return focus ? { row: focus.row, top: focus.rect.top - box.top } : null;
}

function fingersDown(event: Event): number {
  return typeof TouchEvent !== "undefined" && event instanceof TouchEvent
    ? event.touches.length
    : 0;
}

/**
 * Whether a finger is down on the scroller. A touch counts only
 * `TOUCH_STALE_MS` after its last event: one whose release fired on a
 * detached row never reaches the scroller.
 */
function trackFinger(): { see: (event: Event) => void; down: () => boolean } {
  let touching = false;
  let lastTouchAt = Number.NEGATIVE_INFINITY;
  return {
    see: (event) => {
      if (!event.type.startsWith("touch")) return;
      lastTouchAt = performance.now();
      if (event.type === "touchstart") touching = true;
      // Another finger may still be down.
      else if (event.type !== "touchmove") touching = fingersDown(event) > 0;
    },
    down: () => {
      if (touching && performance.now() - lastTouchAt > TOUCH_STALE_MS) touching = false;
      return touching;
    },
  };
}

/** The reader's own input, on top of `USER_SCROLL_EVENTS`: a drag and its release. */
const READER_INPUT_EVENTS = [...USER_SCROLL_EVENTS, "touchmove", "touchend", "touchcancel"];

/**
 * Puts the transcript back after its viewport changes size: a rotation, a
 * foldable folding or unfolding, the browser's toolbar collapsing. Once the
 * resizes have been quiet for `RESIZE_SETTLE_MS`, a transcript pinned to the
 * bottom is pinned again, and one scrolled up has the row the reader was on
 * moved back to where it was.
 *
 * Needed on iOS, where no raw pin follows growth (see `observeListGrowth`) and
 * Virtuoso follows only a new row or a shrinking viewport: the rows re-wrapping
 * to a narrower width grow the list with neither, so a pinned transcript was
 * left above the bottom after a rotation. Its rows above the reader re-wrap
 * too, with no anchor guard there to hold the row on screen.
 *
 * **The reader comes first.** The toolbar collapses in the middle of a drag
 * (the finger went down before the resize) or under its momentum: the view
 * is then the reader's, never put back. Any input (a touch, a wheel, a key)
 * and any scroll outside a resize drops the anchor; it is read again once the
 * view has been still for `ANCHOR_IDLE_MS` with no finger down, so a burst
 * that starts while the view is still moving has none. A re-pin needs the
 * bottom-stick engaged both when the burst starts and when it settles, and no
 * finger down.
 *
 * **Layout reads are gated**: one walk of the rows per still view (not per
 * scroll frame), one per settled resize, none while following or while the
 * workspace is hidden. A window `resize` fires before the frame's scroll
 * events, so a scroll the resize itself causes (a clamp) cannot drop the
 * anchor; a window resize that leaves the scroller's size alone moves nothing.
 * One write per settled resize, never inside the stream: it cannot feed itself.
 */
export function observeResizeSettle(
  scroller: HTMLElement,
  { isFollowing, pinToEnd, writer, isActive }: ResizeSettleOptions,
): { disconnect: () => void } {
  let anchor: ReaderAnchor | null = null;
  let resizing = false;
  /** The scroller itself changed size during this burst (not only the window). */
  let resized = false;
  /** Bottom-stick was engaged when this burst started. */
  let followingAtStart = false;
  /** When this burst started (`performance.now()`). */
  let burstStartAt = 0;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let captureTimer: ReturnType<typeof setTimeout> | null = null;
  let width = scroller.clientWidth;
  let height = scroller.clientHeight;

  const finger = trackFinger();
  const fingerDown = finger.down;
  const cancelCapture = (): void => {
    if (captureTimer !== null) clearTimeout(captureTimer);
    captureTimer = null;
  };
  const capture = (): void => {
    captureTimer = null;
    if (resizing || fingerDown() || !isActive()) return;
    anchor = isFollowing() ? null : readAnchor(scroller);
  };
  const scheduleCapture = (): void => {
    cancelCapture();
    if (!resizing) captureTimer = setTimeout(capture, ANCHOR_IDLE_MS);
  };
  const restoreAnchor = (held: ReaderAnchor): void => {
    if (!held.row.isConnected) return;
    const top = held.row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const drift = top - held.top;
    if (Math.abs(drift) >= 1) writer.scrollBy("resize-anchor", drift);
  };
  /** A jump, a reveal or an index scroll moved the view during this burst: it stands. */
  const movedByProgram = (): boolean =>
    writer.jumpedSince(burstStartAt) || writer.indexScrollSettlesIn() > 0;
  const settle = (): void => {
    settleTimer = null;
    resizing = false;
    const held = anchor;
    anchor = null;
    const changed = resized;
    resized = false;
    if (changed && !fingerDown() && isActive() && !isAutoScrollPinSuppressed()) {
      if (isFollowing()) {
        if (followingAtStart) pinToEnd();
      } else if (held && !movedByProgram()) restoreAnchor(held);
    }
    scheduleCapture();
  };
  const begin = (): void => {
    if (!isActive()) return;
    if (!resizing) {
      followingAtStart = isFollowing();
      burstStartAt = performance.now();
      // The view is still moving (a drag or its momentum): it is the reader's.
      if (captureTimer !== null) anchor = null;
    }
    resizing = true;
    cancelCapture();
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, RESIZE_SETTLE_MS);
  };
  const observer = new ResizeObserver(() => {
    const nextWidth = scroller.clientWidth;
    const nextHeight = scroller.clientHeight;
    if (nextWidth === width && nextHeight === height) return;
    width = nextWidth;
    height = nextHeight;
    if (!isActive()) return;
    resized = true;
    begin();
  });
  const onReaderInput = (event: Event): void => {
    anchor = null;
    finger.see(event);
    scheduleCapture();
  };
  const onScroll = (): void => {
    if (resizing) return;
    anchor = null;
    scheduleCapture();
  };
  observer.observe(scroller);
  window.addEventListener("resize", begin);
  scroller.addEventListener("scroll", onScroll, { passive: true });
  for (const type of READER_INPUT_EVENTS) {
    scroller.addEventListener(type, onReaderInput, { passive: true });
  }
  scheduleCapture();
  return {
    disconnect: () => {
      observer.disconnect();
      window.removeEventListener("resize", begin);
      scroller.removeEventListener("scroll", onScroll);
      for (const type of READER_INPUT_EVENTS) scroller.removeEventListener(type, onReaderInput);
      if (settleTimer !== null) clearTimeout(settleTimer);
      cancelCapture();
    },
  };
}
