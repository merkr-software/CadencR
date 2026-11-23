import { renderHook, waitFor, act } from "@/test-utils";
import type { VirtuosoHandle } from "react-virtuoso";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useAgentSessionScroll } from "./useAgentSessionScroll";
import type { AgentBlockData } from "@/types/agent-block";
import type { HistoryGap } from "@/types/agent-stream";

const isIosMock = vi.fn(() => false);
vi.mock("@/lib/is-ios", () => ({ isIos: () => isIosMock() }));

function makeBlock(id: string): AgentBlockData {
  return { id, type: "text", content: `block ${id}` };
}

function stubGeometry(el: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => clientHeight });
  el.getBoundingClientRect = () =>
    ({
      left: 0,
      right: 100,
      top: 0,
      bottom: 500,
      width: 100,
      height: 500,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}

function dispatchScroll(el: HTMLElement, scrollTop: number): void {
  el.scrollTop = scrollTop;
  act(() => {
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
}

async function waitForAnimationFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

function rect(top: number, height: number): DOMRect {
  return {
    left: 0,
    right: 100,
    top,
    bottom: top + height,
    width: 100,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function stubRow(row: HTMLElement, index: number, top: number, height: number): void {
  row.setAttribute("data-item-index", String(index));
  row.getBoundingClientRect = () => rect(top, height);
}

/**
 * Virtuoso's item list holding the reader's row (on screen, at the top of the
 * 0–500 viewport) and one gap row at `top`, in layout order.
 */
function mountGapRow(
  scroller: HTMLElement,
  { top, hasAbove }: { top: number; hasAbove: boolean },
): HTMLElement {
  const list = document.createElement("div");
  list.setAttribute("data-testid", "virtuoso-item-list");
  const reader = document.createElement("div");
  stubRow(reader, 1001, 0, 200);
  reader.appendChild(document.createElement("div")).setAttribute("data-block-id", "msg-600");
  const row = document.createElement("div");
  stubRow(row, top < 0 ? 1000 : 1002, top, 24);
  const gap = row.appendChild(document.createElement("div"));
  gap.setAttribute("data-history-gap-id", "g1");
  if (hasAbove) gap.setAttribute("data-history-gap-has-above", "");
  gap.getBoundingClientRect = () => rect(top, 24);
  list.append(...(top < 0 ? [row, reader] : [reader, row]));
  scroller.appendChild(list);
  return gap;
}

const GAPS: HistoryGap[] = [{ id: "g1", afterId: 10, beforeId: 500 }];
const SHRUNK_GAPS: HistoryGap[] = [{ id: "g1", afterId: 10, beforeId: 400 }];

type FillGap = (gapId: string, direction: "older" | "newer") => Promise<void>;

/** The reader's own input: the wheel the scroll comes from. */
function wheelUp(scroller: HTMLElement): void {
  act(() => {
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
  });
}

function renderGapScroll(
  onFillGap: FillGap,
  gapRow: { top: number; hasAbove: boolean } = { top: -300, hasAbove: true },
  { engaged = true }: { engaged?: boolean } = {},
) {
  const hook = renderHook(
    ({
      conversationKey,
      historyGaps = GAPS,
    }: {
      conversationKey: string;
      historyGaps?: HistoryGap[];
    }) =>
      useAgentSessionScroll({
        blocks: [makeBlock("1"), makeBlock("2")],
        conversationKey,
        historyGaps,
        onFillGap,
      }),
    {
      initialProps: { conversationKey: "conversation-a" } as {
        conversationKey: string;
        historyGaps?: HistoryGap[];
      },
    },
  );
  const scroller = document.createElement("div");
  stubGeometry(scroller, 2_000, 500);
  const gap = mountGapRow(scroller, gapRow);
  act(() => hook.result.current.scrollContainerRef(scroller));
  // HistoryGapRow registers itself as it mounts.
  act(() => {
    hook.result.current.historyGapStatus.trackRow(gap);
  });
  if (engaged) wheelUp(scroller);
  onTestFinished(() => act(() => hook.result.current.scrollContainerRef(null)));
  return { ...hook, scroller };
}

afterEach(() => {
  isIosMock.mockReturnValue(false);
});

describe("useAgentSessionScroll history gaps", () => {
  it("fills a mounted gap row above the reader from the reader's side", async () => {
    const onFillGap = vi.fn(async () => {});
    const { scroller } = renderGapScroll(onFillGap);

    dispatchScroll(scroller, 900);

    await waitFor(() =>
      expect(onFillGap).toHaveBeenCalledWith("g1", "older", expect.any(Function)),
    );
  });

  it("fills a gap row below the reader downward from the rows above it", async () => {
    const onFillGap = vi.fn(async () => {});
    const { scroller } = renderGapScroll(onFillGap, { top: 420, hasAbove: true });

    dispatchScroll(scroller, 900);

    await waitFor(() =>
      expect(onFillGap).toHaveBeenCalledWith("g1", "newer", expect.any(Function)),
    );
  });

  it("fills a gap with nothing loaded above it upward, wherever it sits", async () => {
    const onFillGap = vi.fn(async () => {});
    const { scroller } = renderGapScroll(onFillGap, { top: 420, hasAbove: false });

    dispatchScroll(scroller, 900);

    await waitFor(() =>
      expect(onFillGap).toHaveBeenCalledWith("g1", "older", expect.any(Function)),
    );
  });

  it("runs one fill at a time, and keeps filling while the gap row stays mounted", async () => {
    let resolveFill: () => void = () => {};
    const onFillGap = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFill = resolve;
        }),
    );
    const { result, rerender, scroller } = renderGapScroll(onFillGap);

    dispatchScroll(scroller, 900);
    await waitFor(() => expect(onFillGap).toHaveBeenCalledTimes(1));
    expect(result.current.historyGapStatus.fillingGapId).toBe("g1");
    dispatchScroll(scroller, 800);
    await waitForAnimationFrame();
    expect(onFillGap).toHaveBeenCalledTimes(1);

    // The page shrinks the gap; its row is still mounted, so the next one loads.
    rerender({ conversationKey: "conversation-a", historyGaps: SHRUNK_GAPS });
    act(() => resolveFill());
    await waitFor(() => expect(onFillGap).toHaveBeenCalledTimes(2));
  });

  it("does not refill a gap that a fill left unchanged", async () => {
    const onFillGap = vi.fn(async () => {});
    const { scroller } = renderGapScroll(onFillGap);

    dispatchScroll(scroller, 900);
    await waitFor(() => expect(onFillGap).toHaveBeenCalledTimes(1));
    await waitForAnimationFrame();
    await waitForAnimationFrame();
    expect(onFillGap).toHaveBeenCalledTimes(1);
  });

  it("stands down while a jump settles, and fills once it has", async () => {
    const onFillGap = vi.fn(async () => {});
    const { result, scroller } = renderGapScroll(onFillGap);
    let settled: () => void = () => {};

    act(() => {
      result.current.startJump((done) => {
        settled = done;
        return () => {};
      });
    });
    dispatchScroll(scroller, 900);
    await waitForAnimationFrame();
    expect(onFillGap).not.toHaveBeenCalled();

    act(() => settled());
    await waitFor(() =>
      expect(onFillGap).toHaveBeenCalledWith("g1", "older", expect.any(Function)),
    );
  });

  it("keeps a newer jump's hold when an older jump it replaced settles", async () => {
    const onFillGap = vi.fn(async () => {});
    const { result, scroller } = renderGapScroll(onFillGap);
    const releases: Array<() => void> = [];
    const start = (): void => {
      act(() => {
        result.current.startJump((done) => {
          releases.push(done);
          return done;
        });
      });
    };

    start();
    start();
    dispatchScroll(scroller, 900);
    await waitForAnimationFrame();
    expect(onFillGap).not.toHaveBeenCalled();

    act(() => releases[1]());
    await waitFor(() => expect(onFillGap).toHaveBeenCalledTimes(1));
  });

  it("stands down while a jump holds the view, until the reader's next input", async () => {
    const onFillGap = vi.fn(async () => {});
    const { result, scroller } = renderGapScroll(onFillGap);

    act(() => {
      result.current.startJump(() => () => {});
    });
    dispatchScroll(scroller, 900);
    await waitForAnimationFrame();
    expect(onFillGap).not.toHaveBeenCalled();

    act(() => {
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    });
    await waitFor(() =>
      expect(onFillGap).toHaveBeenCalledWith("g1", "older", expect.any(Function)),
    );
  });

  it("stops after a failed fill until the reader retries", async () => {
    const onFillGap = vi.fn(async () => {
      throw new Error("Service unavailable");
    });
    const { result, scroller } = renderGapScroll(onFillGap);

    dispatchScroll(scroller, 900);
    await waitFor(() =>
      expect(result.current.historyGapStatus.failures.get("g1")).toBe("Service unavailable"),
    );
    dispatchScroll(scroller, 800);
    await waitForAnimationFrame();
    expect(onFillGap).toHaveBeenCalledTimes(1);

    act(() => result.current.historyGapStatus.retry());
    await waitFor(() => expect(onFillGap).toHaveBeenCalledTimes(2));
  });

  it("tries each gap once while the service fails, instead of alternating between them", async () => {
    const onFillGap = vi.fn(async () => {
      throw new Error("Service unavailable");
    });
    const { result, rerender, scroller } = renderGapScroll(onFillGap);
    const second = scroller
      .querySelector("[data-testid=virtuoso-item-list]")!
      .appendChild(document.createElement("div"));
    second.setAttribute("data-item-index", "1003");
    const gap = second.appendChild(document.createElement("div"));
    gap.setAttribute("data-history-gap-id", "g2");
    gap.getBoundingClientRect = () => rect(450, 24);
    second.getBoundingClientRect = () => rect(450, 24);
    rerender({
      conversationKey: "conversation-a",
      historyGaps: [...GAPS, { id: "g2", afterId: 600, beforeId: 700 }],
    });
    act(() => {
      result.current.historyGapStatus.trackRow(gap);
    });

    await waitFor(() => expect(result.current.historyGapStatus.failures.size).toBe(2));
    for (let frame = 0; frame < 5; frame += 1) await waitForAnimationFrame();
    expect(onFillGap).toHaveBeenCalledTimes(2);
  });

  it("forgets a failure once another load closed its gap", async () => {
    const onFillGap = vi.fn(async () => {
      throw new Error("Service unavailable");
    });
    const { result, rerender, scroller } = renderGapScroll(onFillGap);

    dispatchScroll(scroller, 900);
    await waitFor(() => expect(result.current.historyGapStatus.failures.has("g1")).toBe(true));

    rerender({ conversationKey: "conversation-a", historyGaps: [] });
    expect(result.current.historyGapStatus.failures.size).toBe(0);
  });

  it("drops a fill still in flight when the conversation changes", async () => {
    const onFillGap = vi.fn(
      () =>
        new Promise<void>(() => {
          // Intentionally unresolved until after the conversation switch.
        }),
    );
    const { result, rerender, scroller } = renderGapScroll(onFillGap);

    dispatchScroll(scroller, 900);
    await waitFor(() => expect(result.current.historyGapStatus.fillingGapId).toBe("g1"));

    rerender({ conversationKey: "conversation-b" });
    expect(result.current.historyGapStatus.fillingGapId).toBeNull();
  });

  it("does not prefetch a gap off screen before the reader scrolls or jumps", async () => {
    const onFillGap = vi.fn(async () => {});
    const { scroller } = renderGapScroll(onFillGap, undefined, { engaged: false });

    dispatchScroll(scroller, 900);
    await waitForAnimationFrame();
    await waitForAnimationFrame();
    expect(onFillGap).not.toHaveBeenCalled();

    wheelUp(scroller);
    await waitFor(() =>
      expect(onFillGap).toHaveBeenCalledWith("g1", "older", expect.any(Function)),
    );
  });

  it("fills a gap already on screen as the conversation opens, from below while following", async () => {
    const onFillGap = vi.fn(async () => {});
    // Bottom-stick holds at open: the gap fills from below, so the rows it adds
    // push it up and away instead of keeping it on screen page after page.
    renderGapScroll(onFillGap, { top: 300, hasAbove: true }, { engaged: false });

    await waitFor(() =>
      expect(onFillGap).toHaveBeenCalledWith("g1", "older", expect.any(Function)),
    );
  });

  it("keeps auto-scroll engaged during upward programmatic measurement corrections", () => {
    const { result, scroller } = renderGapScroll(
      vi.fn(async () => {}),
      undefined,
      {
        engaged: false,
      },
    );

    dispatchScroll(scroller, 900);
    dispatchScroll(scroller, 850);

    expect(result.current.autoScrollEnabled).toBe(true);
  });

  // Virtuoso re-runs its `scrollerRef` effect whenever the ref changes: every
  // scroller listener and observer detaches and re-attaches, and the scroll
  // anchor guard drops its bridge mid-frame.
  it("keeps the scroll container ref stable across stick and gap-fill toggles", async () => {
    let resolveFill: () => void = () => {};
    const onFillGap = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFill = resolve;
        }),
    );
    const { result, rerender, scroller } = renderGapScroll(onFillGap);
    const { scrollContainerRef } = result.current;

    act(() => {
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    });
    dispatchScroll(scroller, 900);
    await waitFor(() => expect(result.current.historyGapStatus.fillingGapId).toBe("g1"));
    expect(result.current.autoScrollEnabled).toBe(false);
    rerender({ conversationKey: "conversation-a", historyGaps: SHRUNK_GAPS });
    act(() => resolveFill());
    await waitFor(() => expect(onFillGap).toHaveBeenCalledTimes(2));

    expect(result.current.scrollContainerRef).toBe(scrollContainerRef);
  });
});

describe("useAgentSessionScroll bottom pinning", () => {
  it("keeps Virtuoso's own follow off outside iOS, and pins height changes to the real bottom", () => {
    isIosMock.mockReturnValue(false);
    const { result } = renderHook(() =>
      useAgentSessionScroll({
        blocks: [makeBlock("1"), makeBlock("2")],
        conversationKey: "conversation-a",
      }),
    );
    // `false`, not a callback: given any callback, Virtuoso also follows on
    // size increase and viewport shrink with its index scroll, which lands short.
    expect(result.current.followOutput).toBe(false);
    const scrollToIndex = vi.fn();
    result.current.virtuosoRef.current = { scrollToIndex } as unknown as VirtuosoHandle;
    const scroller = document.createElement("div");
    stubGeometry(scroller, 2_000, 500);
    act(() => result.current.scrollContainerRef(scroller));

    act(() => result.current.onTotalListHeightChanged(2_000));

    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(scroller.scrollTop).toBe(1_500);
    act(() => result.current.scrollContainerRef(null));
  });

  it("hands a glide in flight to the scroll offset when the reader wheels up", () => {
    isIosMock.mockReturnValue(false);
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    onTestFinished(() => raf.mockRestore());
    const { result } = renderHook(() =>
      useAgentSessionScroll({
        blocks: [makeBlock("1"), makeBlock("2")],
        conversationKey: "conversation-a",
      }),
    );
    const scroller = document.createElement("div");
    const list = document.createElement("div");
    list.setAttribute("data-testid", "virtuoso-item-list");
    const row = list.appendChild(document.createElement("div"));
    scroller.appendChild(list);
    stubGeometry(scroller, 2_000, 500);
    let top = 1_468;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (next: number) => {
        top = Math.min(Math.max(0, next), 1_500);
      },
    });
    act(() => result.current.scrollContainerRef(scroller));

    // A streamed line: pinned at once, the rows held 32 px down to glide up.
    act(() => result.current.onTotalListHeightChanged(2_000));
    expect(top).toBe(1_500);
    expect(row.style.transform).toContain("32px");

    // The reader wheels up mid-glide: the rows stay exactly where they are
    // seen, as scroll offset rather than transform, before the anchor guard
    // gets to measure them.
    act(() => {
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    });
    expect(result.current.autoScrollEnabled).toBe(false);
    expect(row.style.transform).toBe("");
    expect(top).toBe(1_468);
    act(() => result.current.scrollContainerRef(null));
  });

  it("does not carry a glide in flight into the next conversation", () => {
    isIosMock.mockReturnValue(false);
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    onTestFinished(() => raf.mockRestore());
    const { result, rerender } = renderHook(
      ({ conversationKey }: { conversationKey: string }) =>
        useAgentSessionScroll({ blocks: [makeBlock("1")], conversationKey }),
      { initialProps: { conversationKey: "conversation-a" } },
    );
    const scroller = document.createElement("div");
    const list = document.createElement("div");
    list.setAttribute("data-testid", "virtuoso-item-list");
    const row = list.appendChild(document.createElement("div"));
    scroller.appendChild(list);
    stubGeometry(scroller, 2_000, 500);
    scroller.scrollTop = 1_468;
    act(() => result.current.scrollContainerRef(scroller));
    act(() => result.current.onTotalListHeightChanged(2_000));
    expect(row.style.transform).toContain("32px");

    rerender({ conversationKey: "conversation-b" });

    expect(row.style.transform).toBe("");
    act(() => result.current.scrollContainerRef(null));
  });

  it("lets Virtuoso follow output on iOS while bottom-stick holds", () => {
    isIosMock.mockReturnValue(true);
    const { result } = renderHook(() =>
      useAgentSessionScroll({
        blocks: [makeBlock("1"), makeBlock("2")],
        conversationKey: "conversation-a",
      }),
    );
    const follow = result.current.followOutput;
    expect(typeof follow === "function" ? follow(true) : follow).toBe("auto");
  });

  it("does not feed iOS height changes back into Virtuoso scrolling", () => {
    isIosMock.mockReturnValue(true);
    const { result } = renderHook(() =>
      useAgentSessionScroll({
        blocks: [makeBlock("1"), makeBlock("2")],
        conversationKey: "conversation-a",
      }),
    );
    const scrollToIndex = vi.fn();
    result.current.virtuosoRef.current = { scrollToIndex } as unknown as VirtuosoHandle;

    act(() => {
      result.current.onTotalListHeightChanged(200);
      result.current.onTotalListHeightChanged(300);
    });

    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  it("keeps explicit iOS bottom navigation without raw scrollTop pinning", async () => {
    isIosMock.mockReturnValue(true);
    const { result } = renderHook(() =>
      useAgentSessionScroll({
        blocks: [makeBlock("1"), makeBlock("2")],
        conversationKey: "conversation-a",
      }),
    );
    const scrollToIndex = vi.fn();
    result.current.virtuosoRef.current = { scrollToIndex } as unknown as VirtuosoHandle;
    const scroller = document.createElement("div");
    stubGeometry(scroller, 2_000, 500);
    let scrollTop = 0;
    let scrollTopWrites = 0;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
        scrollTopWrites += 1;
      },
    });

    act(() => {
      result.current.scrollContainerRef(scroller);
      result.current.scrollToBottom();
    });
    await waitForAnimationFrame();

    expect(scrollToIndex).toHaveBeenCalledOnce();
    expect(scrollTopWrites).toBe(0);
    act(() => result.current.scrollContainerRef(null));
  });
});
