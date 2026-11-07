// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { usePowerBusySignal } from "./usePowerBusySignal";

const bridge = vi.hoisted(() => ({
  isElectron: true,
  setBusy: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/desktop-bridge", () => ({ desktopBridge: bridge }));

describe("usePowerBusySignal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    bridge.setBusy.mockClear();
    useSessionStatusStore.setState({ bySession: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
    useSessionStatusStore.setState({ bySession: {} });
  });

  it("holds the blocker for an agent the backend reports working with no conversation loaded", () => {
    const { unmount } = renderHook(() => usePowerBusySignal());

    act(() => {
      useSessionStatusStore.setState({
        bySession: { 7: { status: "agent", kind: null, featureId: 3, seq: 1 } },
      });
    });
    vi.advanceTimersByTime(300);
    expect(bridge.setBusy).toHaveBeenLastCalledWith(true);

    act(() => {
      useSessionStatusStore.setState({
        bySession: { 7: { status: "question", kind: "permission", featureId: 3, seq: 2 } },
      });
    });
    vi.advanceTimersByTime(300);
    expect(bridge.setBusy).toHaveBeenLastCalledWith(false);
    unmount();
  });
});
