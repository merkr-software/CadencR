// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { useSessionStatusStore } from "@/stores/session-status-store";
import {
  useFeaturePendingRequestId,
  useMostRecentPendingFeatureId,
} from "@/stores/pending-gate-popover-selectors";
import { renderHook } from "@testing-library/react";

describe("pending-gate-popover-selectors", () => {
  it("picks the highest-seq pending feature as most recent", () => {
    useSessionStatusStore.setState({
      bySession: {
        1: { status: "question", kind: "permission", featureId: 10, seq: 1 },
        2: { status: "question", kind: "question", featureId: 20, seq: 5 },
        3: { status: "agent", kind: null, featureId: 30, seq: 9 },
      },
    });

    const { result } = renderHook(() => useMostRecentPendingFeatureId());
    expect(result.current).toBe(20);
  });

  it("tiebreaks equal seq with higher session id", () => {
    useSessionStatusStore.setState({
      bySession: {
        4: { status: "question", kind: "permission", featureId: 10, seq: 3 },
        7: { status: "question", kind: "permission", featureId: 20, seq: 3 },
      },
    });

    const { result } = renderHook(() => useMostRecentPendingFeatureId());
    expect(result.current).toBe(20);
  });

  it("reads the newest pending request id for a feature", () => {
    useSessionStatusStore.setState({
      bySession: {
        1: {
          status: "question",
          kind: "permission",
          featureId: 10,
          seq: 1,
          requestId: "old",
        },
        2: {
          status: "question",
          kind: "permission",
          featureId: 10,
          seq: 4,
          requestId: "new",
        },
      },
    });

    const { result } = renderHook(() => useFeaturePendingRequestId(10));
    expect(result.current).toBe("new");
  });
});
