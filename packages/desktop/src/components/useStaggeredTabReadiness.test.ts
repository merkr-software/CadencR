import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStaggeredTabReadiness, type NonAgentTabReadiness } from "./useAgentFirstNonAgentWork";

// Mirrors STAGGER_STEP_MS in the implementation. Each successive tab reveals
// one step apart; advancing N steps reveals the first N tabs in priority order.
const STEP_MS = 120;

const NONE: NonAgentTabReadiness = {
  editor: false,
  git: false,
  terminal: false,
  browser: false,
};

describe("useStaggeredTabReadiness", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stays fully unready while disabled", () => {
    const { result } = renderHook(() =>
      useStaggeredTabReadiness({ enabled: false, immediateTab: null, resetKey: "a" }),
    );
    act(() => void vi.advanceTimersByTime(STEP_MS * 8));
    expect(result.current).toEqual(NONE);
  });

  it("reveals tabs one at a time in priority order once enabled", () => {
    const { result } = renderHook(() =>
      useStaggeredTabReadiness({ enabled: true, immediateTab: null, resetKey: "a" }),
    );

    expect(result.current).toEqual(NONE);
    act(() => void vi.advanceTimersByTime(STEP_MS));
    expect(result.current).toMatchObject({ editor: true, git: false });
    act(() => void vi.advanceTimersByTime(STEP_MS));
    expect(result.current).toMatchObject({ editor: true, git: true, terminal: false });
    act(() => void vi.advanceTimersByTime(STEP_MS * 2));
    expect(result.current).toEqual({
      editor: true,
      git: true,
      terminal: true,
      browser: true,
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
    act(() => void vi.advanceTimersByTime(STEP_MS * 4));
    expect(result.current).toMatchObject({ editor: true, browser: true });

    // Switching conversation must reset readiness on the very next render — no
    // stale "ready" frame from the previous conversation can leak through.
    rerender({ enabled: true, immediateTab: null, resetKey: "b" });
    expect(result.current).toEqual(NONE);

    // ...and the stagger restarts for the new conversation.
    act(() => void vi.advanceTimersByTime(STEP_MS));
    expect(result.current).toMatchObject({ editor: true, git: false });
  });
});
