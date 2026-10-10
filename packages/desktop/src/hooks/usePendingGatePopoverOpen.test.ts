// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { usePendingGatePopoverHoverStore } from "@/stores/pending-gate-popover-hover-store";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { usePendingGatePopoverOpen } from "./usePendingGatePopoverOpen";

const FEATURE_ID = 42;

function seedPendingGate(): void {
  useSessionStatusStore.setState({
    bySession: {
      7: {
        status: "question",
        kind: "permission",
        requestId: "request-1",
        featureId: FEATURE_ID,
        seq: 1,
      },
    },
  });
}

describe("usePendingGatePopoverOpen", () => {
  afterEach(() => {
    useSessionStatusStore.setState({ bySession: {} });
    usePendingGatePopoverHoverStore.setState({ hoveredFeatureId: null });
  });

  it("auto-opens the most recent pending gate for an inactive conversation", () => {
    seedPendingGate();
    const { result } = renderHook(() => usePendingGatePopoverOpen(FEATURE_ID, true));
    expect(result.current.open).toBe(true);
  });

  it("does not auto-open for the currently open conversation", () => {
    seedPendingGate();
    const { result } = renderHook(() => usePendingGatePopoverOpen(FEATURE_ID, false));
    expect(result.current.open).toBe(false);
  });

  it("closes an auto-opened popover when its conversation becomes active", async () => {
    seedPendingGate();
    usePendingGatePopoverHoverStore.setState({ hoveredFeatureId: FEATURE_ID });
    const { result, rerender } = renderHook(
      ({ allowAutoOpen }) => usePendingGatePopoverOpen(FEATURE_ID, allowAutoOpen),
      { initialProps: { allowAutoOpen: true } },
    );
    expect(result.current.open).toBe(true);

    rerender({ allowAutoOpen: false });
    await waitFor(() => expect(result.current.open).toBe(false));
    expect(usePendingGatePopoverHoverStore.getState().hoveredFeatureId).toBeNull();
  });

  it("still allows the active conversation's popover to be opened manually", () => {
    seedPendingGate();
    const { result } = renderHook(() => usePendingGatePopoverOpen(FEATURE_ID, false));

    act(() => result.current.setOpen(true));
    expect(result.current.open).toBe(true);
  });
});
