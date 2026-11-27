// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANCHOR_IDLE_MS, RESIZE_SETTLE_MS, observeResizeSettle } from "./stream-resize-settle";

/**
 * A rotation or a fold re-wraps the transcript: on iOS nothing else puts the
 * view back (no raw pin, no anchor guard), so this does, once the resize settled.
 */

let resizeCallbacks: (() => void)[] = [];
/** The writer's program-driven moves: an index scroll still settling, the last jump. */
let indexSettles = 0;
let jumpedAt = Number.NEGATIVE_INFINITY;

class FakeResizeObserver {
  constructor(private readonly callback: () => void) {}
  observe(): void {
    resizeCallbacks.push(this.callback);
  }
  disconnect(): void {
    resizeCallbacks = resizeCallbacks.filter((callback) => callback !== this.callback);
  }
}

interface Fixture {
  scroller: HTMLElement;
  setSize: (width: number, height: number) => void;
  /** Moves the row's top edge (from the scroller's top, which sits at 0). */
  setRowTop: (top: number) => void;
  /** How many times the row's geometry was read. */
  rowReads: () => number;
}

function rect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, left: 0, right: 400, width: 400, height } as DOMRect;
}

function fixture(): Fixture {
  const scroller = document.createElement("div");
  const list = document.createElement("div");
  list.setAttribute("data-testid", "virtuoso-item-list");
  const row = document.createElement("div");
  row.setAttribute("data-item-index", "10");
  row.appendChild(document.createElement("p"));
  list.appendChild(row);
  scroller.appendChild(list);
  document.body.appendChild(scroller);
  let size = { width: 400, height: 800 };
  let rowTop = 120;
  let rowReads = 0;
  Object.defineProperty(scroller, "clientWidth", { get: () => size.width });
  Object.defineProperty(scroller, "clientHeight", { get: () => size.height });
  scroller.getBoundingClientRect = () => rect(0, size.height);
  row.getBoundingClientRect = () => {
    rowReads += 1;
    return rect(rowTop, 200);
  };
  return {
    scroller,
    setSize: (width, height) => {
      size = { width, height };
    },
    setRowTop: (top) => {
      rowTop = top;
    },
    rowReads: () => rowReads,
  };
}

function resize(target: Fixture, width: number, height: number): void {
  target.setSize(width, height);
  resizeCallbacks.forEach((callback) => callback());
}

function dispatch(target: Fixture, type: string): void {
  target.scroller.dispatchEvent(new Event(type));
}

interface Harness {
  pinToEnd: ReturnType<typeof vi.fn>;
  scrollBy: ReturnType<typeof vi.fn>;
  disconnect: () => void;
}

function observe(
  target: Fixture,
  {
    following = false,
    active = true,
  }: { following?: boolean | (() => boolean); active?: boolean } = {},
): Harness {
  const pinToEnd = vi.fn();
  const scrollBy = vi.fn();
  const isFollowing = typeof following === "function" ? following : () => following;
  const { disconnect } = observeResizeSettle(target.scroller, {
    isFollowing,
    pinToEnd,
    writer: {
      scrollBy,
      indexScrollSettlesIn: () => indexSettles,
      jumpedSince: (since: number) => jumpedAt >= since,
    },
    isActive: () => active,
  });
  return { pinToEnd, scrollBy, disconnect };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  resizeCallbacks = [];
  indexSettles = 0;
  jumpedAt = Number.NEGATIVE_INFINITY;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("observeResizeSettle", () => {
  it("pins a following transcript again once a rotation settled, once", () => {
    const target = fixture();
    const { pinToEnd, scrollBy } = observe(target, { following: true });

    resize(target, 800, 360);
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(RESIZE_SETTLE_MS - 1);
    expect(pinToEnd).not.toHaveBeenCalled();
    resize(target, 800, 330); // the toolbar collapsing right after
    vi.advanceTimersByTime(RESIZE_SETTLE_MS);
    expect(pinToEnd).toHaveBeenCalledTimes(1);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("does not re-pin when the reader released the bottom during the resize", () => {
    const target = fixture();
    let following = true;
    const { pinToEnd } = observe(target, { following: () => following });
    resize(target, 800, 360);
    following = false; // a drag up let go of the bottom
    vi.advanceTimersByTime(RESIZE_SETTLE_MS);
    expect(pinToEnd).not.toHaveBeenCalled();
  });

  it("moves nothing when only the window resized (a hidden workspace keeps its box)", () => {
    const target = fixture();
    const { pinToEnd } = observe(target, { following: true });
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(RESIZE_SETTLE_MS * 2);
    expect(pinToEnd).not.toHaveBeenCalled();
  });

  it("puts the reader's row back where it was before the resize", () => {
    const target = fixture();
    const { scrollBy } = observe(target);
    vi.advanceTimersByTime(ANCHOR_IDLE_MS); // the first anchor read
    // The window resizes first, then rows above re-wrap and push the row down.
    window.dispatchEvent(new Event("resize"));
    target.setRowTop(340);
    dispatch(target, "scroll"); // a clamp: must not drop the anchor
    resize(target, 300, 800);
    vi.advanceTimersByTime(RESIZE_SETTLE_MS + 20);
    expect(scrollBy).toHaveBeenCalledTimes(1);
    expect(scrollBy).toHaveBeenCalledWith("resize-anchor", 220);
  });

  it("keeps a jump made during the resize instead of putting the old row back", () => {
    const target = fixture();
    const { scrollBy } = observe(target);
    vi.advanceTimersByTime(ANCHOR_IDLE_MS);
    window.dispatchEvent(new Event("resize"));
    target.setRowTop(340);
    resize(target, 300, 800);
    jumpedAt = performance.now(); // a prompt-rail jump lands inside the burst
    vi.advanceTimersByTime(RESIZE_SETTLE_MS + 20);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("keeps an index scroll still settling during the resize", () => {
    const target = fixture();
    const { scrollBy } = observe(target);
    vi.advanceTimersByTime(ANCHOR_IDLE_MS);
    window.dispatchEvent(new Event("resize"));
    target.setRowTop(340);
    resize(target, 300, 800);
    indexSettles = 500;
    vi.advanceTimersByTime(RESIZE_SETTLE_MS + 20);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("reads the rows once the view is still, not on every scroll frame", () => {
    const target = fixture();
    observe(target);
    vi.advanceTimersByTime(ANCHOR_IDLE_MS);
    const before = target.rowReads();
    for (let frame = 0; frame < 10; frame += 1) {
      dispatch(target, "scroll");
      vi.advanceTimersByTime(16);
    }
    expect(target.rowReads()).toBe(before);
    vi.advanceTimersByTime(ANCHOR_IDLE_MS);
    expect(target.rowReads()).toBe(before + 1);
  });

  it("leaves the view to a reader who touches it during the resize", () => {
    const target = fixture();
    const { scrollBy } = observe(target);
    vi.advanceTimersByTime(ANCHOR_IDLE_MS);
    resize(target, 300, 800);
    target.setRowTop(340);
    dispatch(target, "touchstart");
    vi.advanceTimersByTime(RESIZE_SETTLE_MS + 20);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("does not snap back a drag the toolbar collapsed under", () => {
    const target = fixture();
    const { scrollBy } = observe(target);
    vi.advanceTimersByTime(ANCHOR_IDLE_MS);
    // The finger goes down and drags before the toolbar collapses.
    dispatch(target, "touchstart");
    dispatch(target, "touchmove");
    target.setRowTop(60);
    dispatch(target, "scroll");
    resize(target, 400, 860);
    target.setRowTop(20);
    vi.advanceTimersByTime(RESIZE_SETTLE_MS + 20);
    dispatch(target, "touchend");
    vi.advanceTimersByTime(RESIZE_SETTLE_MS + ANCHOR_IDLE_MS);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("does not snap back momentum that runs into the resize after the finger lifted", () => {
    const target = fixture();
    const { scrollBy } = observe(target);
    vi.advanceTimersByTime(ANCHOR_IDLE_MS);
    dispatch(target, "touchstart");
    dispatch(target, "touchend");
    // Momentum: scroll frames after the release, the toolbar collapsing among them.
    for (let frame = 0; frame < 3; frame += 1) {
      target.setRowTop(120 - frame * 30);
      dispatch(target, "scroll");
      vi.advanceTimersByTime(16);
    }
    resize(target, 400, 860);
    target.setRowTop(0);
    dispatch(target, "scroll");
    vi.advanceTimersByTime(RESIZE_SETTLE_MS + 20);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("does not snap back a release that lands during the resize", () => {
    const target = fixture();
    const { scrollBy } = observe(target);
    vi.advanceTimersByTime(ANCHOR_IDLE_MS);
    resize(target, 400, 860);
    dispatch(target, "touchend");
    target.setRowTop(0);
    vi.advanceTimersByTime(RESIZE_SETTLE_MS + 20);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("does nothing in a hidden workspace, not even a layout read", () => {
    const target = fixture();
    const { pinToEnd, scrollBy } = observe(target, { active: false });
    vi.advanceTimersByTime(ANCHOR_IDLE_MS);
    window.dispatchEvent(new Event("resize"));
    resize(target, 300, 800);
    target.setRowTop(340);
    vi.advanceTimersByTime(RESIZE_SETTLE_MS * 2);
    expect(pinToEnd).not.toHaveBeenCalled();
    expect(scrollBy).not.toHaveBeenCalled();
    expect(target.rowReads()).toBe(0);
  });

  it("stops listening on disconnect", () => {
    const target = fixture();
    const { pinToEnd, disconnect } = observe(target, { following: true });
    resize(target, 800, 360);
    disconnect();
    vi.advanceTimersByTime(RESIZE_SETTLE_MS * 2);
    expect(pinToEnd).not.toHaveBeenCalled();
  });
});
