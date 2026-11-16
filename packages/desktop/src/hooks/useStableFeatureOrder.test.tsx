import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Feature } from "@/api/generated";
import { useSessionStatusStore, type SessionStatusEntry } from "@/stores/session-status-store";
import { RESORT_THROTTLE_MS, useStableFeatureOrder } from "./useStableFeatureOrder";

function feature(id: number): Feature {
  return { id, project_id: 1, title: `Feature ${id}`, status: "active" } as unknown as Feature;
}

function features(...ids: number[]): Feature[] {
  return ids.map(feature);
}

function ids(list: readonly Feature[]): number[] {
  return list.map((entry) => entry.id);
}

function setStatus(featureId: number, status: SessionStatusEntry["status"]): void {
  useSessionStatusStore.setState((state) => ({
    bySession: {
      ...state.bySession,
      [featureId * 10]: { status, kind: null, featureId, seq: Date.now() },
    },
  }));
}

describe("useStableFeatureOrder", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useSessionStatusStore.setState({ bySession: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds rows in place while a turn runs and re-sorts when it ends", () => {
    const { result, rerender } = renderHook(({ list }) => useStableFeatureOrder(list), {
      initialProps: { list: features(1, 2, 3) },
    });
    act(() => setStatus(3, "agent"));
    // Sending the prompt moved 3 to the top of the backend order.
    rerender({ list: features(3, 1, 2) });
    expect(ids(result.current)).toEqual([1, 2, 3]);

    act(() => setStatus(3, "idle"));
    act(() => vi.runOnlyPendingTimers());
    expect(ids(result.current)).toEqual([3, 1, 2]);
  });

  it("re-sorts at most once per throttle window", () => {
    const { result, rerender } = renderHook(({ list }) => useStableFeatureOrder(list), {
      initialProps: { list: features(1, 2, 3) },
    });
    act(() => {
      setStatus(2, "agent");
      setStatus(3, "agent");
    });
    rerender({ list: features(2, 1, 3) });
    act(() => setStatus(2, "idle"));
    act(() => vi.runOnlyPendingTimers());
    expect(ids(result.current)).toEqual([2, 1, 3]);

    rerender({ list: features(3, 2, 1) });
    act(() => setStatus(3, "idle"));
    act(() => vi.advanceTimersByTime(RESORT_THROTTLE_MS - 100));
    expect(ids(result.current)).toEqual([2, 1, 3]);
    act(() => vi.advanceTimersByTime(100));
    expect(ids(result.current)).toEqual([3, 2, 1]);
  });

  it("shows a new conversation on top without re-sorting the rest", () => {
    const { result, rerender } = renderHook(({ list }) => useStableFeatureOrder(list), {
      initialProps: { list: features(1, 2) },
    });
    rerender({ list: features(2, 1, 9) });
    expect(ids(result.current)).toEqual([9, 1, 2]);
  });

  it("settles when the caller passes a fresh empty list on every render", () => {
    // `const { data = [] } = useQuery(...)` hands over a new array each render while loading.
    const { result } = renderHook(() => useStableFeatureOrder([]));
    expect(result.current).toEqual([]);
  });
});
