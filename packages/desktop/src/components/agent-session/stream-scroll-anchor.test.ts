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

function createStream(
  rows: RowSpec[],
  {
    paddingTop = 0,
    scrollTop = 0,
    // Like a browser laying out shorter content, the scroll offset clamps
    // whenever it is read, not only when it is written.
    clampOnLayout = false,
    // Virtuoso's header and footer, laid out around the list.
    header = 0,
    footer = 0,
  } = {},
) {
  const scroller = document.createElement("div");
  const viewport = document.createElement("div");
  const list = document.createElement("div");
  list.setAttribute("data-testid", "virtuoso-item-list");
  const chrome = (height: number): HTMLElement => {
    const element = document.createElement("div");
    Object.defineProperty(element, "offsetHeight", { configurable: true, get: () => height });
    return element;
  };
  viewport.append(chrome(header), list, chrome(footer));
  scroller.appendChild(viewport);
  document.body.appendChild(scroller);
  const state = { rows, paddingTop, scrollTop, clientHeight: VIEWPORT };
  const translate = (): number => {
    const match = /translateY\((-?[\d.]+)px\)/.exec(list.style.transform);
    return match ? Number(match[1]) : 0;
  };
  const rowTop = (spec: RowSpec): number => {
    let top = header + state.paddingTop;
    for (const row of state.rows) {
      if (row === spec) break;
      top += row.height;
    }
    return top;
  };
  const contentHeight = (): number =>
    header +
    Math.max(
      state.paddingTop + state.rows.reduce((sum, row) => sum + row.height, 0),
      Number.parseFloat(list.style.minHeight) || 0,
    ) +
    footer;
  const clamp = (next: number): number => Math.max(0, Math.min(next, contentHeight() - VIEWPORT));
  const laidOutScrollTop = (): number => {
    if (clampOnLayout) state.scrollTop = clamp(state.scrollTop);
    return state.scrollTop;
  };
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: laidOutScrollTop,
    set: (next: number) => {
      state.scrollTop = clamp(next);
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
        // `gap:<id>` stands for a history gap's row, which renders no block.
        if (spec.block.startsWith("gap:")) {
          block.setAttribute("data-history-gap-id", spec.block.slice(4));
        } else {
          block.setAttribute("data-block-id", spec.block);
        }
        row.appendChild(block);
        row.getBoundingClientRect = () =>
          rect(SCROLLER_TOP + rowTop(spec) - laidOutScrollTop() + translate(), spec.height);
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

/**
 * Runs the callbacks queued for the next frame; one must be queued. Like a
 * browser, it skips a callback cancelled by an earlier one in the same frame.
 */
function stepFrame(time: number): void {
  const queued = [...frames.keys()];
  expect(queued.length).toBeGreaterThan(0);
  for (const id of queued) {
    const callback = frames.get(id);
    if (!callback) continue;
    frames.delete(id);
    callback(time);
  }
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
    // Nothing left for the fallback to settle: only the scroll range floor,
    // released two quiet frames later.
    stepFrame(16);
    stepFrame(32);
    expect(frames.size).toBe(0);
    expect(stream.list.style.minHeight).toBe("");
  });

  it("keeps the scroll range from clamping the view while a page lands near the end", async () => {
    // The reader is 100 px above the last row, the footer below it.
    const stream = guarded(
      createStream(
        [row(1000, 10, 100), row(1001, 11, 300), row(1002, 12, 300), row(1003, 13, 300)],
        { paddingTop: 1000, scrollTop: 1524, clampOnLayout: true, header: 24, footer: 40 },
      ),
    );
    const native = vi.spyOn(Element.prototype, "scrollBy").mockImplementation(() => {});
    expect(stream.visualTop(1003)).toBe(200);

    // Virtuoso's prepend: its compensation first, then its offset (800 px)...
    stream.scroller.scrollBy({ top: 800 });
    stream.state.paddingTop = 1800;
    stream.render();
    await flush();
    stream.guard.measureItem(stream.list.firstElementChild as HTMLElement, "offsetHeight");
    // ...dropped for a commit before the rows' real padding (700 px) lands.
    stream.state.paddingTop = 1000;
    stream.render();
    await flush();
    // Held to the viewport's bottom, not past it: the header and footer
    // still lay out around the list.
    expect(stream.list.style.minHeight).toBe(`${2324 + 400 - 64}px`);
    stream.state.paddingTop = 1700;
    stream.render();
    await flush();

    expect(native).not.toHaveBeenCalled();
    expect(stream.visualTop(1003)).toBe(200);
    stepFrame(16);
    stepFrame(32);
    expect(stream.visualTop(1003)).toBe(200);
    // The settle held the floor again: it lets go two quiet frames later.
    expect(stream.list.style.minHeight).not.toBe("");
    stepFrame(48);
    stepFrame(64);
    expect(stream.list.style.minHeight).toBe("");
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

  it("measures the commit Virtuoso compensates from inside, before its observer reports it", () => {
    const stream = readingMidList();
    const native = vi.spyOn(Element.prototype, "scrollBy").mockImplementation(() => {});

    // Same task as the commit: no mutation record delivered yet.
    mountTallRowAbove(stream);
    stream.scroller.scrollBy({ top: 460 });

    expect(native).not.toHaveBeenCalled();
    expect(stream.scroller.scrollTop).toBe(1560);
    expect(stream.list.style.transform).toBe("");
    expect(stream.visualTop(1001)).toBe(0);
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
    // Every floor the list goes through, in order (each style record keeps
    // the value it replaced).
    const styles: string[] = [];
    const recorder = new MutationObserver((records) => {
      for (const record of records) styles.push(record.oldValue ?? "");
    });
    recorder.observe(stream.list, { attributeFilter: ["style"], attributeOldValue: true });
    const floors = async (): Promise<string[]> => {
      await flush();
      const values = [...styles, stream.list.getAttribute("style") ?? ""].map(
        (style) => /min-height:\s*([^;]+)/.exec(style)?.[1].trim() ?? "",
      );
      return values.filter((value, index) => index === 0 || value !== values[index - 1]);
    };
    mountTallRowAbove(stream);
    await flush();

    stepFrame(0);
    expect(stream.scroller.scrollTop).toBe(1100);
    stepFrame(16);
    expect(stream.scroller.scrollTop).toBe(1560);
    expect(stream.list.style.transform).toBe("");
    expect(stream.visualTop(1001)).toBe(0);
    // The scroll range stayed held through the settle's write, and lets go
    // two quiet frames after it.
    expect(await floors()).toEqual(["", "1500px", "1960px"]);
    stepFrame(32);
    stepFrame(48);
    expect((await floors()).at(-1)).toBe("");
  });

  it("stands down while bottom-stick is engaged, leaving Virtuoso's scrollBy to the bottom pin", async () => {
    const stream = readingMidList();
    const native = vi.spyOn(Element.prototype, "scrollBy").mockImplementation(() => {});
    stream.engaged.current = true;

    mountTallRowAbove(stream);
    await flush();
    expect(stream.list.style.transform).toBe("");

    // 960 padding + 500 + 100 + 3 × 300 of rows.
    Object.defineProperty(stream.scroller, "scrollHeight", { configurable: true, get: () => 2460 });
    stream.scroller.scrollBy({ top: 460, behavior: "auto" });
    expect(native).not.toHaveBeenCalled();
    expect(stream.state.scrollTop).toBe(2460 - VIEWPORT);
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

  it("anchors on the rows a jump left on screen once it settles", async () => {
    const stream = readingMidList();
    const release = stream.guard.suspend();

    release();
    // No scroll since: the release itself picked the anchor.
    mountTallRowAbove(stream);
    await flush();
    expect(stream.visualTop(1001)).toBe(0);
  });

  it("ignores an older jump's release once a newer jump holds the view", async () => {
    const stream = readingMidList();
    const releaseOlder = stream.guard.suspend();
    stream.guard.suspend();

    releaseOlder();
    mountTallRowAbove(stream);
    await flush();
    expect(stream.list.style.transform).toBe("");
  });

  it("anchors past a gap row at the top of the view, as its page lands under it", async () => {
    // The reader scrolled up to the gap: it fills from their side, under its
    // row, and the row they were reading must hold.
    const stream = guarded(
      createStream([row(1000, 0, 24, "gap:g1"), row(1001, 1, 300), row(1002, 2, 300)]),
    );

    stream.render([
      row(998, 0, 24, "gap:g1"),
      row(999, 1, 200, "older-a"),
      row(1000, 2, 250, "older-b"),
      row(1001, 3, 300),
      row(1002, 4, 300),
    ]);
    await flush();

    expect(stream.visualTop(1001)).toBe(24);
  });

  it("holds the reader's row while the gap below it fills downward", async () => {
    // A far prompt's turn at the top of the view, the gap after it below: it
    // fills from the turn's end, above the gap's row, and the turn holds.
    const stream = guarded(
      createStream([row(1000, 0, 300, "turn"), row(1001, 1, 24, "gap:g2"), row(1002, 2, 300)]),
    );

    stream.render([
      row(1000, 0, 300, "turn"),
      row(1001, 1, 200, "newer-a"),
      row(1002, 2, 24, "gap:g2"),
      row(1003, 3, 300),
    ]);
    await flush();

    expect(stream.visualTop(1000)).toBe(0);
    expect(stream.list.style.transform).toBe("");
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

  it("puts the anchor's row back where the reader saw it, however the list moved while it was gone", async () => {
    const stream = readingMidList();
    vi.spyOn(Element.prototype, "scrollBy").mockImplementation(() => {});
    const rows = stream.state.rows;

    stream.render([row(900, 0, 300, "new-a"), row(901, 1, 300, "new-b")]);
    await flush();
    // Moved by an offset no `scrollBy` reports: Virtuoso's deviation, or a clamp.
    stream.state.scrollTop = 900;
    stream.scroll();
    stream.state.paddingTop = 1400;
    stream.render(rows);
    await flush();

    expect(stream.visualTop(1001)).toBe(0);
  });

  it("lets Virtuoso's compensation run while the anchor's row is gone, then lets go at input", async () => {
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

    // The reader's own scroll lets the missing row go and sets a new baseline.
    stream.scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    stream.scroll();
    stream.state.rows[0].height = 400;
    stream.render();
    await flush();
    expect(stream.list.style.transform).toBe("translateY(-150px)");
  });

  it("nets Virtuoso's estimate out once the anchor's row comes back", async () => {
    const stream = readingMidList();
    vi.spyOn(Element.prototype, "scrollBy").mockImplementation((...args: unknown[]) => {
      const [options] = args;
      if (typeof options === "object" && options !== null && "top" in options) {
        stream.state.scrollTop += Number(options.top);
      }
    });
    const rows = stream.state.rows;

    // A page lands above: Virtuoso first renders the old offset over new rows,
    // unmounting the anchor's row, then scrolls by its estimate (500 px)...
    stream.render([row(900, 0, 300, "new-a"), row(901, 1, 300, "new-b")]);
    await flush();
    stream.scroller.scrollBy({ top: 500 });
    stream.scroll();
    // ...and the row comes back, 400 px lower than it was in the content.
    stream.state.paddingTop = 1400;
    stream.render(rows);
    await flush();

    expect(stream.visualTop(1001)).toBe(0);
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
