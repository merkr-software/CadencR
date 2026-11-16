// @vitest-environment happy-dom
/**
 * Tests for the selectors that expose live agent-status to the four UI
 * surfaces (sidebar feature row, agent view badge, unified-agents grid,
 * unified-agents sidebar button). The store itself is exercised via the
 * `app/session_status.*` envelope handlers in
 * `session-status-handlers.test.ts` — this file focuses on the React
 * selectors used by consumers.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useSessionStatusStore, type SessionStatusEntry } from "@/stores/session-status-store";
import {
  aggregateFeatureStatus,
  useLiveActiveSessionIds,
  useLiveTotalWorkingCount,
  useLiveWorkingCount,
} from "@/stores/session-status-selectors";

function seedSession(sessionId: number, entry: SessionStatusEntry): void {
  useSessionStatusStore.setState((s) => ({
    bySession: { ...s.bySession, [sessionId]: entry },
  }));
}

function resetStore(): void {
  useSessionStatusStore.setState({ bySession: {} });
}

describe("session-status-store selectors", () => {
  afterEach(resetStore);

  it("useLiveWorkingCount returns the count of `agent` sessions within the id set", () => {
    seedSession(1, { status: "agent", kind: null, featureId: 10, seq: 1 });
    seedSession(2, { status: "agent", kind: null, featureId: 11, seq: 2 });
    seedSession(3, { status: "question", kind: "permission", featureId: 12, seq: 3 });
    seedSession(4, { status: "idle", kind: null, featureId: 13, seq: 4 });

    const { result } = renderHook(() => useLiveWorkingCount([1, 2, 3, 4]));
    // `question` and `idle` are not counted; only `agent`.
    expect(result.current).toBe(2);
  });

  it("useLiveWorkingCount ignores ids not in the requested set", () => {
    seedSession(1, { status: "agent", kind: null, featureId: 10, seq: 1 });
    seedSession(2, { status: "agent", kind: null, featureId: 11, seq: 2 });

    const { result } = renderHook(() => useLiveWorkingCount([1]));
    expect(result.current).toBe(1);
  });

  it("useLiveWorkingCount re-renders when a tracked session flips to `agent`", () => {
    seedSession(1, { status: "idle", kind: null, featureId: 10, seq: 1 });
    const { result } = renderHook(() => useLiveWorkingCount([1]));
    expect(result.current).toBe(0);

    act(() => {
      seedSession(1, { status: "agent", kind: null, featureId: 10, seq: 2 });
    });
    expect(result.current).toBe(1);

    act(() => {
      seedSession(1, { status: "idle", kind: null, featureId: 10, seq: 3 });
    });
    expect(result.current).toBe(0);
  });

  it("useLiveTotalWorkingCount counts every `agent` session regardless of REST visibility", () => {
    // Models the case the sidebar button cares about: an agent that
    // started after the last REST refetch must still bump the counter
    // the moment its `session_status.update` lands.
    seedSession(99, { status: "agent", kind: null, featureId: 10, seq: 1 });
    seedSession(100, { status: "agent", kind: null, featureId: 11, seq: 2 });
    seedSession(101, { status: "question", kind: "question", featureId: 12, seq: 3 });
    seedSession(102, { status: "idle", kind: null, featureId: 13, seq: 4 });

    const { result } = renderHook(() => useLiveTotalWorkingCount());
    expect(result.current).toBe(2);

    act(() => {
      seedSession(102, { status: "agent", kind: null, featureId: 13, seq: 5 });
    });
    expect(result.current).toBe(3);
  });

  it("useLiveActiveSessionIds returns the sorted list of non-idle session ids", () => {
    seedSession(2, { status: "question", kind: "permission", featureId: 11, seq: 2 });
    seedSession(1, { status: "agent", kind: null, featureId: 10, seq: 1 });
    seedSession(3, { status: "idle", kind: null, featureId: 12, seq: 3 });

    const { result } = renderHook(() => useLiveActiveSessionIds());
    expect(result.current).toEqual([1, 2]);
  });

  it("useLiveActiveSessionIds returns a stable reference across no-op store updates", () => {
    seedSession(1, { status: "agent", kind: null, featureId: 10, seq: 1 });
    const { result } = renderHook(() => useLiveActiveSessionIds());
    const initial = result.current;
    expect(initial).toEqual([1]);

    // Mutating an unrelated session's `seq` must NOT produce a new array
    // reference — otherwise every WS update would re-render every grid
    // consumer that depends on this selector.
    act(() => {
      seedSession(1, { status: "agent", kind: null, featureId: 10, seq: 2 });
    });
    expect(result.current).toBe(initial);
  });

  it("useLiveActiveSessionIds updates when a session becomes non-idle", () => {
    const { result } = renderHook(() => useLiveActiveSessionIds());
    expect(result.current).toEqual([]);

    act(() => {
      seedSession(7, { status: "agent", kind: null, featureId: 99, seq: 1 });
    });
    expect(result.current).toEqual([7]);
  });

  it("aggregateFeatureStatus prefers question over agent over idle", () => {
    expect(
      aggregateFeatureStatus([
        { status: "idle", kind: null, featureId: 1, seq: 1 },
        { status: "agent", kind: null, featureId: 1, seq: 2 },
        { status: "question", kind: "permission", featureId: 1, seq: 3 },
      ]),
    ).toEqual({ status: "question", kind: "permission" });

    expect(
      aggregateFeatureStatus([
        { status: "idle", kind: null, featureId: 1, seq: 1 },
        { status: "agent", kind: null, featureId: 1, seq: 2 },
      ]),
    ).toEqual({ status: "agent", kind: null });
  });
});
