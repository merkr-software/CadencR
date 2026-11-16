// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScrollAnchorGuard } from "./stream-scroll-anchor";
import { StreamScrollWriter } from "./stream-scroll-writer";

const isIosMock = vi.fn(() => false);
vi.mock("@/lib/is-ios", () => ({ isIos: () => isIosMock() }));

/**
 * The guard reads real geometry, which happy-dom doesn't lay out. These tests
 * model a Virtuoso list instead: rows stacked under a `paddingTop`, positioned
 * from the scroll offset and from whatever `transform` the guard puts on the
 * list — the same numbers a browser would report.
 */
const SCROLLER_TOP = 50;
const VIEWPORT = 400;

interface RowSpec {
  index: number;
  local: number;
  block: string;
  height: number;
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(target: Element): void {
    this.targets.add(target);
  }
  unobserve(target: Element): void {
    this.targets.delete(target);
  }
  disconnect(): void {
    this.targets.clear();
  }
  fire(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

function rect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
  } as DOMRect;
}

function createStream(rows: RowSpec[], { paddingTop = 0, scrollTop = 0 } = {}) {
  const scroller = document.createElement("div");
  const list = document.createElement("div");
  list.setAttribute("data-testid", "virtuoso-item-list");
  scroller.appendChild(list);
  document.body.appendChild(scroller);
  const state = { rows, paddingTop, scrollTop, clientHeight: VIEWPORT };
  const translate = (): number => {
    const match = /translateY\((-?[\d.]+)px\)/.exec(list.style.transform);
    return match ? Number(match[1]) : 0;
  };
  const rowTop = (spec: RowSpec): number => {
    let top = state.paddingTop;
    for (const row of state.rows) {
      if (row === spec) break;
      top += row.height;
    }
    return top;
  };
  const contentHeight = (): number =>
    state.paddingTop + state.rows.reduce((sum, row) => sum + row.height, 0);
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => state.scrollTop,
    set: (next: number) => {
      state.scrollTop = Math.max(0, Math.min(next, contentHeight() - VIEWPORT));
    },
  });
  Object.defineProperty(scroller, "clientHeight", {
    configurable: true,
    get: () => state.clientHeight,
  });
  scroller.getBoundingClientRect = () => rect(SCROLLER_TOP, VIEWPORT);
  const render = (next: RowSpec[] = state.rows): void => {
    state.rows = next;
    list.replaceChildren(
      ...next.map((spec) => {
        const row = document.createElement("div");
        row.setAttribute("data-index", String(spec.local));
        row.setAttribute("data-item-index", String(spec.index));
        const block = document.createElement("div");
        block.setAttribute("data-block-id", spec.block);
        row.appendChild(block);
        row.getBoundingClientRect = () =>
          rect(SCROLLER_TOP + rowTop(spec) - state.scrollTop + translate(), spec.height);
        return row;
      }),
    );
  };
  render();
  /** Where a row's top sits in the viewport — what the reader sees. */
  const visualTop = (index: number): number | undefined => {
    const row = list.querySelector(`[data-item-index="${index}"]`);
    return row ? row.getBoundingClientRect().top - SCROLLER_TOP : undefined;
  };
  const scroll = (): void => {
    scroller.dispatchEvent(new Event("scroll"));
  };
  return { scroller, list, state, render, visualTop, scroll };
}

/** MutationObserver records are delivered on a microtask. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function row(index: number, local: number, height: number, block = `b${index}`): RowSpec {
  return { index, local, block, height };
}

/** Attaches a guard to `stream`; the first scroll sets its anchor. */
function guarded(stream: ReturnType<typeof createStream>) {
  const engaged = { current: false };
  const guard = new ScrollAnchorGuard(() => engaged.current);
  // Virtuoso's `scrollBy` reaches the guard through the stream's writer.
  const writer = new StreamScrollWriter({
    isFollowing: () => engaged.current,
    prepareJump: () => {},
  });
  writer.attach(stream.scroller);
  guard.attach(stream.scroller, writer);
  stream.scroll();
  return { ...stream, guard, engaged, writer };
}

/** Rows 1000–1003 with 1001 at the top of the viewport. */
function readingMidList() {
  return guarded(
    createStream([row(1000, 10, 100), row(1001, 11, 300), row(1002, 12, 300), row(1003, 13, 300)], {
      paddingTop: 1000,
      scrollTop: 1100,
    }),
  );
}

/** Virtuoso mounts row 999 above: estimated at 40px, it lays out at 500px. */
function mountTallRowAbove(stream: ReturnType<typeof readingMidList>): void {
  stream.state.paddingTop = 960;
  stream.render([row(999, 9, 500), ...stream.state.rows]);
}

/** Animation frames run only when a test steps them, so the fallback settle is deterministic. */
const frames = new Map<number, FrameRequestCallback>();
let lastFrameId = 0;

/** Runs the callbacks queued for the next frame; one must be queued. */
function stepFrame(time: number): void {
  const queued = [...frames.values()];
  frames.clear();
  expect(queued.length).toBeGreaterThan(0);
  for (const callback of queued) callback(time);
}

describe("ScrollAnchorGuard", () => {
  beforeEach(() => {
    FakeResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    isIosMock.mockReturnValue(false);
    frames.clear();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      lastFrameId += 1;
      frames.set(lastFrameId, callback);
      return lastFrameId;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("bridges growth above the anchor in the same frame, without scrolling", async () => {
    const stream = readingMidList();
    expect(stream.visualTop(1001)).toBe(0);

    mountTallRowAbove(stream);
    await flush();

    expect(stream.visualTop(1001)).toBe(0);
    expect(stream.list.style.transform).toBe("translateY(-460px)");
    expect(stream.scroller.scrollTop).toBe(1100);
  });

  it("settles the bridge into the scroll offset on Virtuoso's next measurement", async () => {
    const stream = readingMidList();
    mountTallRowAbove(stream);
    await flush();

    const measured = stream.list.querySelector('[data-item-index="999"]') as HTMLElement;
    expect(stream.guard.measureItem(measured, "offsetHeight")).toBe(500);

    expect(stream.scroller.scrollTop).toBe(1560);
    expect(stream.list.style.transform).toBe("");
    expect(stream.visualTop(1001)).toBe(0);
    // Nothing left for the fallback to settle.
    expect(frames.size).toBe(0);
  });

  it("honours Virtuoso's own compensation only up to the measured drift", async () => {
    const stream = readingMidList();
    mountTallRowAbove(stream);
    await flush();

    stream.scroller.scrollBy(0, 200);
    expect(stream.scroller.scrollTop).toBe(1300);
    expect(stream.list.style.transform).toBe("translateY(-260px)");

    stream.scroller.scrollBy({ top: 600, behavior: "auto" });
    expect(stream.scroller.scrollTop).toBe(1560);
    expect(stream.list.style.transform).toBe("");
    expect(stream.visualTop(1001)).toBe(0);

    stream.scroller.scrollBy({ top: 50, behavior: "auto" });
    expect(stream.scroller.scrollTop).toBe(1560);
  });

  it("drops compensation for growth below the reader, such as a streamed reply", async () => {
    const stream = readingMidList();
    stream.render(
      stream.state.rows.map((spec) => (spec.index === 1003 ? { ...spec, height: 900 } : spec)),
    );
    await flush();
    expect(stream.list.style.transform).toBe("");

    stream.scroller.scrollBy({ top: 600, behavior: "auto" });
    expect(stream.scroller.scrollTop).toBe(1100);
    expect(stream.visualTop(1001)).toBe(0);
  });

  it("catches rows resizing in place through the ResizeObserver", () => {
    const stream = readingMidList();
    const [observer] = FakeResizeObserver.instances;
    const resized = stream.list.querySelector('[data-item-index="1000"]') as Element;
    expect(observer.targets.has(resized)).toBe(true);

    stream.state.rows[0].height = 250;
    observer.fire();

    expect(stream.visualTop(1001)).toBe(0);
    expect(stream.list.style.transform).toBe("translateY(-150px)");
  });

  it("observes the rows Virtuoso mounts and lets go of the ones it unmounts", async () => {
    const stream = readingMidList();
    const [observer] = FakeResizeObserver.instances;

    mountTallRowAbove(stream);
    await flush();

    expect([...observer.targets]).toEqual([...stream.list.children]);
  });

  it("settles on its own two frames later when no measurement pass follows", async () => {
    const stream = readingMidList();
    mountTallRowAbove(stream);
    await flush();

    stepFrame(0);
    expect(stream.scroller.scrollTop).toBe(1100);
    stepFrame(16);
    expect(stream.scroller.scrollTop).toBe(1560);
    expect(stream.list.style.transform).toBe("");
    expect(stream.visualTop(1001)).toBe(0);
  });

  it("stands down while bottom-stick is engaged", async () => {
    const stream = readingMidList();
    const native = vi.spyOn(Element.prototype, "scrollBy").mockImplementation(() => {});
    stream.engaged.current = true;

    mountTallRowAbove(stream);
    await flush();
    expect(stream.list.style.transform).toBe("");

    stream.scroller.scrollBy({ top: 460, behavior: "auto" });
    expect(native).toHaveBeenCalledWith({ top: 460, behavior: "auto" });
  });

  it("stands down while the stream is hidden", async () => {
    const stream = readingMidList();
    stream.state.clientHeight = 0;

    mountTallRowAbove(stream);
    await flush();

    expect(stream.list.style.transform).toBe("");
  });

  it("hands the viewport to a programmatic jump until the reader scrolls again", async () => {
    const stream = readingMidList();
    const native = vi.spyOn(Element.prototype, "scrollBy").mockImplementation(() => {});
    stream.guard.suspend();

    mountTallRowAbove(stream);
    await flush();
    expect(stream.list.style.transform).toBe("");
    stream.scroller.scrollBy({ top: 460 });
    expect(native).toHaveBeenCalledTimes(1);

    stream.scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    stream.scroll();
    stream.state.rows[0].height = 600;
    stream.render();
    await flush();
    expect(stream.list.style.transform).toBe("translateY(-100px)");
  });

  it("anchors below the first row, which older pages are inserted under", async () => {
    // The session's first prompt (row 0) and the window's first rows are on
    // screen when a page lands between them.
    const stream = guarded(
      createStream([row(1000, 0, 80, "prompt"), row(1001, 1, 300), row(1002, 2, 300)]),
    );

    stream.render([
      row(998, 0, 80, "prompt"),
      row(999, 1, 200, "older-a"),
      row(1000, 2, 250, "older-b"),
      row(1001, 3, 300),
      row(1002, 4, 300),
    ]);
    await flush();

    expect(stream.visualTop(1001)).toBe(80);
  });

  it("follows the first row by position when it is all that is on screen", async () => {
    const stream = guarded(createStream([row(1000, 0, 900, "prompt"), row(1001, 1, 300)]));

    // A page lands below the prompt; its newest row takes over index 1000.
    stream.render([
      row(998, 0, 900, "prompt"),
      row(999, 1, 200, "older-a"),
      row(1000, 2, 250, "older-b"),
      row(1001, 3, 300),
    ]);
    await flush();

    expect(stream.visualTop(1000)).toBe(0);
  });

  it("keeps a row re-keyed in place anchored by its index", async () => {
    const stream = readingMidList();
    stream.state.rows[0].height = 160;
    stream.render(
      stream.state.rows.map((spec) =>
        spec.index === 1001 ? { ...spec, block: "recap-v2" } : spec,
      ),
    );
    await flush();

    expect(stream.visualTop(1001)).toBe(0);
    expect(stream.list.style.transform).toBe("translateY(-60px)");
  });

  it("trusts Virtuoso's compensation until the next scroll once the anchor row is gone", async () => {
    const stream = readingMidList();
    const native = vi.spyOn(Element.prototype, "scrollBy").mockImplementation(() => {});

    // Virtuoso replaced the rendered range: neither the anchor's block nor its
    // absolute index survives.
    stream.render([row(2000, 20, 100, "x"), row(2001, 21, 300, "y"), row(2002, 22, 300, "z")]);
    await flush();
    stream.state.rows[0].height = 250;
    stream.render();
    await flush();
    expect(stream.list.style.transform).toBe("");
    stream.scroller.scrollBy({ top: 150 });
    expect(native).toHaveBeenCalledWith({ top: 150 });

    // The next scroll sets a new baseline.
    stream.scroll();
    stream.state.rows[0].height = 400;
    stream.render();
    await flush();
    expect(stream.list.style.transform).toBe("translateY(-150px)");
  });

  it("restores the native scrollBy and drops the bridge on detach", async () => {
    const stream = readingMidList();
    const native = vi.spyOn(Element.prototype, "scrollBy").mockImplementation(() => {});
    mountTallRowAbove(stream);
    await flush();
    stream.scroller.scrollBy({ top: 460 });
    expect(native).not.toHaveBeenCalled();

    stream.guard.detach();

    stream.scroller.scrollBy({ top: 460 });
    expect(native).toHaveBeenCalledOnce();
    expect(stream.list.style.transform).toBe("");
    expect(frames.size).toBe(0);
    stream.writer.detach();
    expect(Object.hasOwn(stream.scroller, "scrollBy")).toBe(false);
  });

  it("leaves iOS to Virtuoso's deviation-based correction", () => {
    isIosMock.mockReturnValue(true);
    const stream = createStream([row(1000, 10, 100)]);
    const writer = new StreamScrollWriter();
    writer.attach(stream.scroller);
    new ScrollAnchorGuard(() => false).attach(stream.scroller, writer);

    expect(Object.hasOwn(stream.scroller, "scrollBy")).toBe(false);
    expect(FakeResizeObserver.instances).toHaveLength(0);
  });
});
