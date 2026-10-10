// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FULL_TREE_DEFER_MS, useDeferredFullTreeLoad } from "./useDeferredFullTreeLoad";

describe("useDeferredFullTreeLoad", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the tracked tree and an idle delay before enabling the full tree", () => {
    vi.useFakeTimers();

    const { result, rerender } = renderHook(
      ({ featureId, trackedReady }) => useDeferredFullTreeLoad({ featureId, trackedReady }),
      { initialProps: { featureId: 1, trackedReady: false } },
    );

    expect(result.current).toBe(false);

    rerender({ featureId: 1, trackedReady: true });
    expect(result.current).toBe(false);

    act(() => vi.advanceTimersByTime(FULL_TREE_DEFER_MS - 1));
    expect(result.current).toBe(false);

    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it("resets the deferred full tree when the feature changes", () => {
    vi.useFakeTimers();

    const { result, rerender } = renderHook(
      ({ featureId }) => useDeferredFullTreeLoad({ featureId, trackedReady: true }),
      { initialProps: { featureId: 1 } },
    );

    act(() => vi.advanceTimersByTime(FULL_TREE_DEFER_MS));
    expect(result.current).toBe(true);

    rerender({ featureId: 2 });
    expect(result.current).toBe(false);

    act(() => vi.advanceTimersByTime(FULL_TREE_DEFER_MS));
    expect(result.current).toBe(true);
  });
});
