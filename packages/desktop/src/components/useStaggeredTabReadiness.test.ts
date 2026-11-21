// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStaggeredTabReadiness, type NonAgentTabReadiness } from "./useAgentFirstNonAgentWork";

// Each successive tab reveals one painted frame apart (a frame callback, then
// a task behind it); advancing N frames reveals the first N tabs in priority
// order.
const STEP_MS = 20;

/** One `act` per frame: the next step is scheduled by the previous one's commit. */
function advanceFrames(count: number): void {
  for (let frame = 0; frame < count; frame += 1) {
    act(() => void vi.advanceTimersByTime(STEP_MS));
  }
}

const NONE: NonAgentTabReadiness = {
  editor: false,
  git: false,
  terminal: false,
  browser: false,
  preview: false,
};

describe("useStaggeredTabReadiness", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stays fully unready while disabled", () => {
    const { result } = renderHook(() =>
      useStaggeredTabReadiness({ enabled: false, immediateTab: null, resetKey: "a" }),
    );
    advanceFrames(8);
    expect(result.current).toEqual(NONE);
  });

  it("reveals tabs one at a time in priority order once enabled", () => {
    const { result } = renderHook(() =>
      useStaggeredTabReadiness({ enabled: true, immediateTab: null, resetKey: "a" }),
    );

    expect(result.current).toEqual(NONE);
    advanceFrames(1);
    expect(result.current).toMatchObject({ editor: true, git: false });
    advanceFrames(1);
    expect(result.current).toMatchObject({ editor: true, git: true, terminal: false });
    advanceFrames(3);
    expect(result.current).toEqual({
      editor: true,
      git: true,
      terminal: true,
      browser: true,
      preview: true,
    });
  });

  it("reveals the explicitly focused tab immediately, ahead of the stagger", () => {
    const { result } = renderHook(() =>
      useStaggeredTabReadiness({ enabled: true, immediateTab: "browser", resetKey: "a" }),
    );
    // browser is last in priority order, but the user opened it — ready at once.
    expect(result.current).toMatchObject({ browser: true, editor: false });
  });

  it("drops a prior conversation's readiness synchronously on switch", () => {
    const { result, rerender } = renderHook((props) => useStaggeredTabReadiness(props), {
      initialProps: { enabled: true, immediateTab: null, resetKey: "a" },
    });
    advanceFrames(4);
    expect(result.current).toMatchObject({ editor: true, browser: true });

    // Switching conversation must reset readiness on the very next render — no
    // stale "ready" frame from the previous conversation can leak through.
    rerender({ enabled: true, immediateTab: null, resetKey: "b" });
    expect(result.current).toEqual(NONE);

    // ...and the stagger restarts for the new conversation.
    advanceFrames(1);
    expect(result.current).toMatchObject({ editor: true, git: false });
  });
});
