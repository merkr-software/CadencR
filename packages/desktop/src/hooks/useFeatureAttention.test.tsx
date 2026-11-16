import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { useUnreadStore } from "@/stores/unread-store";
import { useFeatureAttention } from "./useFeatureAttention";

function setSessions(entries: Record<number, { featureId: number; status: "agent" | "question" }>) {
  const bySession = Object.fromEntries(
    Object.entries(entries).map(([id, entry]) => [id, { ...entry, kind: null, seq: 1 }]),
  );
  useSessionStatusStore.setState({ bySession });
}

beforeEach(() => {
  useSessionStatusStore.setState({ bySession: {} });
  useUnreadStore.setState({ byFeature: {} });
});

describe("useFeatureAttention", () => {
  it("reads the row's own status and unread flag", () => {
    const { result } = renderHook(() => useFeatureAttention(1));
    expect(result.current).toEqual({ state: "idle", sourceFeatureId: 1 });

    act(() => useUnreadStore.getState().markUnread(1));
    expect(result.current.state).toBe("unread");

    act(() => setSessions({ 10: { featureId: 1, status: "agent" } }));
    expect(result.current.state).toBe("working");
  });

  it("lets a pending request in any session win", () => {
    setSessions({
      10: { featureId: 1, status: "agent" },
      11: { featureId: 1, status: "question" },
    });
    const { result } = renderHook(() => useFeatureAttention(1));
    expect(result.current.state).toBe("waiting");
  });

  it("surfaces a hidden child's request on the parent", () => {
    const hidden = [2, 3];
    setSessions({ 20: { featureId: 3, status: "question" } });
    const { result } = renderHook(() => useFeatureAttention(1, hidden));
    expect(result.current).toEqual({ state: "waiting", sourceFeatureId: 3 });
  });

  it("ignores other conversations", () => {
    const { result } = renderHook(() => useFeatureAttention(1));
    const before = result.current;
    act(() => setSessions({ 30: { featureId: 9, status: "agent" } }));
    expect(result.current).toBe(before);
  });
});
