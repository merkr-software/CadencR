import { act, render } from "@/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAgentSessionScrollInput } from "./useAgentSessionScrollInput";
import { popResize, pushResize } from "@/lib/resize-coordinator";
import type { ScrollRef } from "./agent-session-scroll-utils";
import { StreamScrollWriter } from "./stream-scroll-writer";

// `observeListGrowth` opts out on iOS entirely; drive that branch explicitly.
const isIosMock = vi.fn(() => false);
vi.mock("@/lib/is-ios", () => ({ isIos: () => isIosMock() }));

// The streaming bottom-pin lives in `observeListGrowth`: a MutationObserver on
// Virtuoso's item list that pins `scrollTop = scrollHeight` when the
// conversation grows, gated on bottom-stick / suppression / resize. The global
// Virtuoso test mock renders no item-list node, so the observer is unreachable
// through AgentSession integration tests — we drive the hook's ref directly
// against a hand-built scroller + item-list instead.

const noop = (): void => {};

// Stable ref params (identity must not change across re-renders, or the
// callback ref would detach/reattach the observer).
const stickRef = { current: true };
const params = {
  scrollerElRef: { current: null as HTMLElement | null },
  stickRef,
  writer: new StreamScrollWriter({ isFollowing: () => stickRef.current, prepareJump: noop }),
  // The guard is unit-tested on its own (stream-scroll-anchor.test.ts).
  anchorGuard: { attach: vi.fn(), detach: vi.fn() },
  historyLoadArmedRef: { current: false },
  lastScrollTopRef: { current: 0 },
  userScrollIntentRef: { current: false },
  suppressScrollIntentRef: { current: false },
  armUserScrollIntent: noop,
  setAutoScrollEnabled: noop,
  requestOlderHistory: noop,
};

let scrollRef: ScrollRef;
function Harness(): null {
  scrollRef = useAgentSessionScrollInput(params);
  return null;
}

interface Scroller {
  scroller: HTMLElement;
  list: HTMLElement;
  /** Append a row AND grow `scrollHeight`, the way streamed content does. */
  appendRow: (heightPx?: number) => void;
  /** Mutate the list WITHOUT changing `scrollHeight` (a Virtuoso re-render). */
  touchList: () => void;
  /** Number of `scrollTop` assignments — a browser emits one `scroll` event each. */
  writes: () => number;
  /** Number of `scrollHeight` reads — each one forces a synchronous layout. */
  geometryReads: () => number;
}

function buildScroller(scrollHeight = 1000, clientHeight = 400): Scroller {
  const scroller = document.createElement("div");
  const list = document.createElement("div");
  list.setAttribute("data-testid", "virtuoso-item-list");
  scroller.appendChild(list);
  document.body.appendChild(scroller);
  let height = scrollHeight;
  let reads = 0;
  Object.defineProperty(scroller, "scrollHeight", {
    configurable: true,
    get: () => {
      reads += 1;
      return height;
    },
  });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => clientHeight });
  // jsdom doesn't clamp `scrollTop` to `scrollHeight - clientHeight` the way a
  // browser does, so model that here — otherwise a pin could "succeed" at a
  // position no real scroller can reach.
  let top = 0;
  let writes = 0;
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (next: number) => {
      writes += 1;
      top = Math.min(Math.max(0, next), Math.max(0, height - clientHeight));
    },
  });
  return {
    scroller,
    list,
    appendRow: (heightPx = 100) => {
      act(() => {
        height += heightPx;
        list.appendChild(document.createElement("div"));
      });
    },
    touchList: () => {
      act(() => {
        list.setAttribute("data-touched", String(Math.random()));
      });
    },
    writes: () => writes,
    geometryReads: () => reads,
  };
}

// MutationObserver records are delivered on the microtask queue; a macrotask
// tick flushes them.
async function flushMutations(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

describe("useAgentSessionScrollInput — streaming bottom-pin", () => {
  afterEach(() => {
    params.stickRef.current = true;
    params.scrollerElRef.current = null;
    isIosMock.mockReturnValue(false);
    document.body.innerHTML = "";
  });

  // On iOS the pin fights Virtuoso's deviation-based correction and the two
  // never converge — measured at ~30 React commits/s of the whole app on an
  // installed PWA, which wedges the UI and trips React error #185. Virtuoso's
  // own `followOutput` covers bottom-stick there.
  it("never pins on iOS", async () => {
    isIosMock.mockReturnValue(true);
    render(<Harness />);
    const { scroller, appendRow, writes } = buildScroller();
    act(() => scrollRef(scroller));

    appendRow();
    await flushMutations();
    appendRow();
    await flushMutations();

    expect(writes()).toBe(0);
  });

  it("pins scrollTop to the bottom when the item list grows while stuck", async () => {
    render(<Harness />);
    const { scroller, appendRow } = buildScroller();
    act(() => scrollRef(scroller));

    appendRow();
    await flushMutations();

    expect(scroller.scrollTop).toBe(700);
  });

  // Bottom-stick is disengaged by the input handlers, which for a scrollbar
  // drag or a keypress only fire once the `scroll` event lands — so there is a
  // window where the reader has moved but stick is still engaged. Virtuoso
  // re-renders on scroll and that re-render is a mutation, so an observer that
  // pinned on any mutation would drag the view straight back to the bottom.
  // Caught in the running app, not by the assertions below it.
  it("does not fight a scroll that has not disengaged bottom-stick yet", async () => {
    render(<Harness />);
    const { scroller, appendRow, touchList } = buildScroller();
    act(() => scrollRef(scroller));
    appendRow();
    await flushMutations();
    expect(scroller.scrollTop).toBe(700);

    // Reader drags upward; stick has not flipped off yet.
    scroller.scrollTop = 500;
    touchList();
    await flushMutations();

    expect(scroller.scrollTop).toBe(500);
  });

  // Regression: the pin used to write `scrollTop` unconditionally. Each write
  // emits a `scroll` event, Virtuoso re-renders on it, that commit mutates the
  // list, and the observer fires again — a self-sustaining loop that pegged the
  // main thread on an iOS standalone PWA. Once pinned, mutations must not write.
  it("does not rewrite scrollTop once the view is already pinned", async () => {
    render(<Harness />);
    const { scroller, appendRow, touchList, writes } = buildScroller();
    act(() => scrollRef(scroller));

    appendRow();
    await flushMutations();
    expect(writes()).toBe(1);

    touchList();
    await flushMutations();
    touchList();
    await flushMutations();

    expect(writes()).toBe(1);
    expect(scroller.scrollTop).toBe(700);
  });

  // WebKit reports a fractional `scrollTop` while `scrollHeight`/`clientHeight`
  // are rounded, so an exact equality guard would never hold and every mutation
  // would rewrite the position — the same loop by another route.
  it("treats a sub-pixel gap as already pinned", async () => {
    render(<Harness />);
    const { scroller, appendRow, writes } = buildScroller();
    act(() => scrollRef(scroller));
    // Grow first, then sit a fraction of a pixel above the bottom.
    appendRow();
    await flushMutations();
    scroller.scrollTop = 699.5;
    const before = writes();

    appendRow(0.4);
    await flushMutations();

    expect(writes()).toBe(before);
  });

  // The callback runs on every mutation batch while an agent streams. Reading
  // `scrollHeight` forces a synchronous layout of the whole transcript, so the
  // paths that exist to do nothing — reader scrolled up, recap animation, split
  // -pane drag — must bail before touching geometry, not after.
  it("reads no geometry on the paths that cannot pin", async () => {
    render(<Harness />);
    const { scroller, appendRow, touchList, geometryReads } = buildScroller();
    params.stickRef.current = false;
    act(() => scrollRef(scroller));
    const before = geometryReads();

    appendRow();
    await flushMutations();
    touchList();
    await flushMutations();

    expect(geometryReads()).toBe(before);
  });

  it("does not pin when bottom-stick is disengaged", async () => {
    render(<Harness />);
    const { scroller, appendRow } = buildScroller();
    params.stickRef.current = false;
    act(() => scrollRef(scroller));

    appendRow();
    await flushMutations();

    expect(scroller.scrollTop).toBe(0);
  });

  it("does not pin while a split-pane resize is in flight", async () => {
    render(<Harness />);
    const { scroller, appendRow } = buildScroller();
    act(() => scrollRef(scroller));

    pushResize();
    try {
      appendRow();
      await flushMutations();
      expect(scroller.scrollTop).toBe(0);
    } finally {
      popResize();
    }
  });

  it("disconnects the observer once the scroller detaches", async () => {
    render(<Harness />);
    const { scroller, appendRow } = buildScroller();
    act(() => scrollRef(scroller));
    act(() => scrollRef(null));

    appendRow();
    await flushMutations();

    expect(scroller.scrollTop).toBe(0);
  });

  it("attaches the scroll anchor guard with the scroller and detaches it after", () => {
    const { attach, detach } = params.anchorGuard;
    attach.mockClear();
    render(<Harness />);
    const { scroller } = buildScroller();

    act(() => scrollRef(scroller));
    expect(attach).toHaveBeenCalledExactlyOnceWith(scroller, params.writer);

    detach.mockClear();
    act(() => scrollRef(null));
    expect(detach).toHaveBeenCalledOnce();
    expect(attach).toHaveBeenCalledOnce();
  });
});
