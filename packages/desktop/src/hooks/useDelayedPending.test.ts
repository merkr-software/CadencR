// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDelayedPending } from "./useDelayedPending";

describe("useDelayedPending", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function advance(ms: number): void {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  }

  it("stays quiet through a wait too short to be worth reporting", () => {
    const { result, rerender } = renderHook(({ value }) => useDelayedPending(value, 400), {
      initialProps: { value: "pr" as string | null },
    });

    // A local save lands in a couple of frames; an indicator that appears and
    // vanishes inside that window reads as a glitch, not as progress.
    advance(50);
    expect(result.current).toBeNull();

    rerender({ value: null });
    advance(1000);
    expect(result.current).toBeNull();
  });

  it("reports a wait that outlasts the delay", () => {
    const { result } = renderHook(() => useDelayedPending("pr", 400));

    advance(399);
    expect(result.current).toBeNull();
    advance(1);
    expect(result.current).toBe("pr");
  });

  it("clears the moment the work resolves, without waiting out the delay again", () => {
    const { result, rerender } = renderHook(({ value }) => useDelayedPending(value, 400), {
      initialProps: { value: "pr" as string | null },
    });
    advance(400);
    expect(result.current).toBe("pr");

    rerender({ value: null });
    // Not a debounce: holding the indicator up after the work finished is the
    // same lie as flashing it before the work was slow.
    expect(result.current).toBeNull();
  });

  it("does not strand the old indicator when the target changes mid-flight", () => {
    const { result, rerender } = renderHook(({ value }) => useDelayedPending(value, 400), {
      initialProps: { value: "pr" as string | null },
    });
    advance(400);
    expect(result.current).toBe("pr");

    // The previous value used to stay up for another full delay, pointing at a
    // save that had already been superseded.
    rerender({ value: "graph" });
    expect(result.current).toBeNull();
    advance(400);
    expect(result.current).toBe("graph");
  });

  it("restarts the delay when the pending target changes before it was ever shown", () => {
    const { result, rerender } = renderHook(({ value }) => useDelayedPending(value, 400), {
      initialProps: { value: "pr" as string | null },
    });

    advance(300);
    rerender({ value: "graph" });
    advance(300);
    // The first target's 300ms does not count toward the second's — otherwise a
    // rapid switch would flash a spinner on the tab you just left.
    expect(result.current).toBeNull();
    advance(100);
    expect(result.current).toBe("graph");
  });

  it("delays work that was already in flight when the caller mounted", () => {
    // The reason this is not `useDebouncedValue` plus a guard: that hook seeds
    // its state with the value it is first handed, which would show the
    // indicator on the very first frame.
    const { result } = renderHook(() => useDelayedPending("pr", 400));
    expect(result.current).toBeNull();
    advance(399);
    expect(result.current).toBeNull();
  });
});
