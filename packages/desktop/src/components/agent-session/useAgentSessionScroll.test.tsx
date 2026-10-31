import { render, renderHook, screen, waitFor, act } from "@/test-utils";
import type { VirtuosoHandle } from "react-virtuoso";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAgentSessionScroll } from "./useAgentSessionScroll";
import type { AgentBlockData } from "@/types/agent-block";

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

function dispatchPointerDown(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 95 }));
  });
}

function dispatchContentPointerDown(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 10 }));
  });
}

async function waitForAnimationFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

interface HarnessProps {
  onLoadOlder: () => Promise<number | void>;
  hasMore?: boolean;
  conversationKey?: string;
}

function Harness({
  onLoadOlder,
  hasMore = true,
  conversationKey = "conversation-a",
}: HarnessProps) {
  const { scrollContainerRef, onStartReached, autoScrollEnabled, isLoadingOlder } =
    useAgentSessionScroll({
      blocks: [makeBlock("1"), makeBlock("2")],
      conversationKey,
      hasMore,
      onLoadOlder,
    });

  return (
    <div>
      <div data-testid="auto-scroll-state">{autoScrollEnabled ? "on" : "off"}</div>
      <div data-testid="older-loading-state">{isLoadingOlder ? "loading" : "idle"}</div>
      <div data-testid="scroller" ref={scrollContainerRef} />
      <button type="button" onClick={onStartReached}>
        start reached
      </button>
    </div>
  );
}

afterEach(() => {
  isIosMock.mockReturnValue(false);
});

describe("useAgentSessionScroll history loading", () => {
  it("loads older history when an upward scrollbar/keyboard scroll lands near the top", async () => {
    const onLoadOlder = vi.fn(async () => 0);
    render(<Harness onLoadOlder={onLoadOlder} />);

    const scroller = screen.getByTestId("scroller");
    stubGeometry(scroller, 2_000, 500);

    dispatchPointerDown(scroller);
    dispatchScroll(scroller, 900);
    dispatchScroll(scroller, 24);

    await waitFor(() => expect(onLoadOlder).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("auto-scroll-state")).toHaveTextContent("off");
  });

  it("requires a new upward scroll before loading another history page", async () => {
    let resolveLoad: () => void = () => {};
    const onLoadOlder = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          resolveLoad = () => resolve(0);
        }),
    );
    render(<Harness onLoadOlder={onLoadOlder} />);

    const scroller = screen.getByTestId("scroller");
    stubGeometry(scroller, 2_000, 500);

    dispatchPointerDown(scroller);
    dispatchScroll(scroller, 900);
    dispatchScroll(scroller, 24);
    await waitFor(() => expect(onLoadOlder).toHaveBeenCalledTimes(1));

    act(() => resolveLoad());
    await waitFor(() => expect(onLoadOlder).toHaveBeenCalledTimes(1));

    await act(async () => {
      screen.getByRole("button", { name: "start reached" }).click();
    });
    expect(onLoadOlder).toHaveBeenCalledTimes(1);

    dispatchPointerDown(scroller);
    dispatchScroll(scroller, 900);
    dispatchScroll(scroller, 24);
    await waitFor(() => expect(onLoadOlder).toHaveBeenCalledTimes(2));
  });

  it("ignores programmatic upward corrections after prepend until new user intent", async () => {
    const onLoadOlder = vi.fn(async () => 0);
    render(<Harness onLoadOlder={onLoadOlder} />);

    const scroller = screen.getByTestId("scroller");
    stubGeometry(scroller, 2_000, 500);

    dispatchPointerDown(scroller);
    dispatchScroll(scroller, 900);
    dispatchScroll(scroller, 24);
    await waitFor(() => expect(onLoadOlder).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId("older-loading-state")).toHaveTextContent("idle"),
    );

    dispatchScroll(scroller, 18);
    dispatchScroll(scroller, 12);

    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it("does not arm history loading from ordinary content clicks", () => {
    const onLoadOlder = vi.fn(async () => 0);
    render(<Harness onLoadOlder={onLoadOlder} />);

    const scroller = screen.getByTestId("scroller");
    stubGeometry(scroller, 2_000, 500);

    dispatchContentPointerDown(scroller);
    dispatchScroll(scroller, 900);
    dispatchScroll(scroller, 24);

    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  it("keeps auto-scroll engaged during upward programmatic measurement corrections", () => {
    const onLoadOlder = vi.fn(async () => 0);
    render(<Harness onLoadOlder={onLoadOlder} />);

    const scroller = screen.getByTestId("scroller");
    stubGeometry(scroller, 2_000, 500);

    dispatchScroll(scroller, 900);
    dispatchScroll(scroller, 850);

    expect(onLoadOlder).not.toHaveBeenCalled();
    expect(screen.getByTestId("auto-scroll-state")).toHaveTextContent("on");
  });

  it("resets an in-flight older-history load when the conversation changes", async () => {
    const firstLoad = vi.fn(
      () =>
        new Promise<number>(() => {
          // Intentionally unresolved until after the conversation switch.
        }),
    );
    const secondLoad = vi.fn(async () => 0);
    const { rerender } = render(
      <Harness onLoadOlder={firstLoad} conversationKey="conversation-a" />,
    );

    const scroller = screen.getByTestId("scroller");
    stubGeometry(scroller, 2_000, 500);

    dispatchPointerDown(scroller);
    dispatchScroll(scroller, 900);
    dispatchScroll(scroller, 24);
    await waitFor(() => expect(firstLoad).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("older-loading-state")).toHaveTextContent("loading");

    rerender(<Harness onLoadOlder={secondLoad} conversationKey="conversation-b" />);
    expect(screen.getByTestId("older-loading-state")).toHaveTextContent("idle");
    await waitForAnimationFrame();

    dispatchPointerDown(scroller);
    dispatchScroll(scroller, 900);
    dispatchScroll(scroller, 24);
    await waitFor(() => expect(secondLoad).toHaveBeenCalledTimes(1));
  });

  // Virtuoso re-runs its `scrollerRef` effect whenever the ref changes: every
  // scroller listener and observer detaches and re-attaches, and the scroll
  // anchor guard drops its bridge mid-frame.
  it("keeps the scroll container ref stable across stick and history-load toggles", async () => {
    let resolveLoad: () => void = () => {};
    const onLoadOlder = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          resolveLoad = () => resolve(0);
        }),
    );
    const { result } = renderHook(() =>
      useAgentSessionScroll({
        blocks: [makeBlock("1"), makeBlock("2")],
        conversationKey: "conversation-a",
        hasMore: true,
        onLoadOlder,
      }),
    );
    const { scrollContainerRef } = result.current;
    const scroller = document.createElement("div");
    stubGeometry(scroller, 2_000, 500);
    act(() => scrollContainerRef(scroller));

    dispatchPointerDown(scroller);
    dispatchScroll(scroller, 900);
    dispatchScroll(scroller, 24);
    await waitFor(() => expect(result.current.isLoadingOlder).toBe(true));
    expect(result.current.autoScrollEnabled).toBe(false);
    act(() => resolveLoad());
    await waitFor(() => expect(result.current.isLoadingOlder).toBe(false));

    expect(result.current.scrollContainerRef).toBe(scrollContainerRef);
    act(() => scrollContainerRef(null));
  });
});

describe("useAgentSessionScroll bottom pinning", () => {
  it("does not feed iOS height changes back into Virtuoso scrolling", () => {
    isIosMock.mockReturnValue(true);
    const { result } = renderHook(() =>
      useAgentSessionScroll({
        blocks: [makeBlock("1"), makeBlock("2")],
        conversationKey: "conversation-a",
        hasMore: false,
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
        hasMore: false,
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
