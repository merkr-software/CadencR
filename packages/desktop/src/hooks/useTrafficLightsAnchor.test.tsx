import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useTrafficLightsAnchor } from "./useTrafficLightsAnchor";

const setTrafficLightsCenter = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/lib/desktop-bridge", () => ({ desktopBridge: { setTrafficLightsCenter } }));

const resizeCallbacks: Array<() => void> = [];
class CapturingResizeObserver {
  constructor(callback: () => void) {
    resizeCallbacks.push(callback);
  }
  observe(): void {}
  disconnect(): void {}
}

function anchor(top: number, height: number, rendered = true) {
  const element = document.createElement("div");
  document.createElement("header").appendChild(element);
  const box = { top, height };
  element.getBoundingClientRect = () => ({ ...box }) as DOMRect;
  element.getClientRects = () => (rendered ? [{}] : []) as unknown as DOMRectList;
  return { ref: { current: element }, box };
}

const flushed = () => Promise.resolve();
// An unmounting header waits for the next page's before the lights go home.
const settled = () => vi.advanceTimersByTimeAsync(250);

describe("useTrafficLightsAnchor", () => {
  const originalResizeObserver = window.ResizeObserver;
  beforeEach(() => {
    setTrafficLightsCenter.mockClear();
    resizeCallbacks.length = 0;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    window.ResizeObserver = CapturingResizeObserver as unknown as typeof ResizeObserver;
  });
  afterEach(() => {
    vi.useRealTimers();
    window.ResizeObserver = originalResizeObserver;
  });

  it("centers the lights on the anchor and follows its row", async () => {
    const { ref, box } = anchor(36, 0);
    const { unmount } = renderHook(() => useTrafficLightsAnchor(ref, true));
    await flushed();
    expect(setTrafficLightsCenter).toHaveBeenLastCalledWith(36);

    // A subtitle grows the row: the anchor's center moves with it.
    box.top = 30;
    box.height = 20;
    resizeCallbacks[0]();
    await flushed();
    expect(setTrafficLightsCenter).toHaveBeenLastCalledWith(40);
    // Same center again sends nothing.
    resizeCallbacks[0]();
    await flushed();
    expect(setTrafficLightsCenter).toHaveBeenCalledTimes(2);

    unmount();
    await flushed();
    expect(setTrafficLightsCenter).toHaveBeenCalledTimes(2);
    await settled();
    expect(setTrafficLightsCenter).toHaveBeenLastCalledWith(null);
  });

  it("restores the system position once inactive", async () => {
    const { ref } = anchor(36, 0);
    const { rerender } = renderHook(({ active }) => useTrafficLightsAnchor(ref, active), {
      initialProps: { active: true },
    });
    await flushed();
    expect(setTrafficLightsCenter).toHaveBeenLastCalledWith(36);
    // The sidebar expanding sends them home at once.
    rerender({ active: false });
    await flushed();
    expect(setTrafficLightsCenter).toHaveBeenLastCalledWith(null);
  });

  it("moves straight from one page's header to the next", async () => {
    const first = anchor(36, 0);
    const second = anchor(22, 0);
    const { rerender, unmount } = renderHook(({ page }) => useTrafficLightsAnchor(page.ref, true), {
      initialProps: { page: first },
    });
    await flushed();
    setTrafficLightsCenter.mockClear();

    rerender({ page: second });
    await flushed();
    // No detour through the system position between the two headers.
    expect(setTrafficLightsCenter.mock.calls).toEqual([[22]]);
    unmount();
    await settled();
  });

  it("waits for a next page whose header is still loading", async () => {
    const leaving = renderHook(() => useTrafficLightsAnchor(anchor(36, 0).ref, true));
    await flushed();
    setTrafficLightsCenter.mockClear();

    leaving.unmount();
    await vi.advanceTimersByTimeAsync(100);
    const next = renderHook(() => useTrafficLightsAnchor(anchor(22, 0).ref, true));
    await settled();
    expect(setTrafficLightsCenter.mock.calls).toEqual([[22]]);
    next.unmount();
    await settled();
  });

  it("keeps the lights on the live header when another one unmounts", async () => {
    const kept = renderHook(() => useTrafficLightsAnchor(anchor(36, 0).ref, true));
    const leaving = renderHook(() => useTrafficLightsAnchor(anchor(22, 0).ref, true));
    await flushed();
    expect(setTrafficLightsCenter).toHaveBeenLastCalledWith(22);

    leaving.unmount();
    await settled();
    expect(setTrafficLightsCenter).toHaveBeenLastCalledWith(36);
    kept.unmount();
    await settled();
  });

  it("leaves the lights alone for a header that isn't laid out", async () => {
    const { ref } = anchor(36, 0, false);
    renderHook(() => useTrafficLightsAnchor(ref, true)).unmount();
    await settled();
    expect(setTrafficLightsCenter).not.toHaveBeenCalled();
  });
});
