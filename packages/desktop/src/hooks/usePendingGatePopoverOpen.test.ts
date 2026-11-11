// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SIDEBAR_CONFIG } from "@/lib/sidebar-config";
import { usePendingGatePopoverStore } from "@/stores/pending-gate-popover-store";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { useSidebarConfigStore } from "@/stores/sidebar-config-store";
import { usePendingGatePopoverOpen } from "./usePendingGatePopoverOpen";

const mobile = vi.hoisted(() => ({ value: false }));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => mobile.value }));

const FEATURE_ID = 42;
const READY = { isActive: false, gateReady: true } as const;

function seedPendingGate(requestId = "request-1", featureId = FEATURE_ID, seq = 1): void {
  useSessionStatusStore.setState((state) => ({
    bySession: {
      ...state.bySession,
      [featureId + 1000]: { status: "question", kind: "permission", requestId, featureId, seq },
    },
  }));
}

function openState() {
  return usePendingGatePopoverStore.getState().open;
}

beforeEach(() => {
  mobile.value = false;
  usePendingGatePopoverStore.setState({
    open: null,
    dismissedRequestIds: new Set(),
    planRequestIds: new Set(),
  });
  useSidebarConfigStore.setState({ config: DEFAULT_SIDEBAR_CONFIG });
});

afterEach(() => {
  vi.useRealTimers();
  useSessionStatusStore.setState({ bySession: {} });
});

describe("usePendingGatePopoverOpen auto-open", () => {
  it("opens the most recent request on the row's surface as an automatic popover", () => {
    seedPendingGate();
    const { result } = renderHook(() => usePendingGatePopoverOpen(FEATURE_ID, true, READY));
    expect(result.current.open).toBe(true);
    expect(result.current.origin).toBe("auto");
    expect(openState()).toMatchObject({ featureId: FEATURE_ID, surface: "tree", origin: "auto" });
  });

  it("does not open for the open conversation, a request still loading or a plan", () => {
    seedPendingGate();
    const inactive = renderHook(() => usePendingGatePopoverOpen(FEATURE_ID, false, READY));
    expect(inactive.result.current.open).toBe(false);
    const loading = renderHook(() =>
      usePendingGatePopoverOpen(FEATURE_ID, true, { isActive: false, gateReady: false }),
    );
    expect(loading.result.current.open).toBe(false);
    expect(openState()).toBeNull();
  });

  it("does not open the request of an older conversation", () => {
    seedPendingGate("old", FEATURE_ID, 1);
    seedPendingGate("new", 99, 5);
    const { result } = renderHook(() => usePendingGatePopoverOpen(FEATURE_ID, true, READY));
    expect(result.current.open).toBe(false);
  });

  it("never reopens a dismissed request, even when the row remounts", () => {
    seedPendingGate();
    const first = renderHook(() => usePendingGatePopoverOpen(FEATURE_ID, true, READY));
    act(() => first.result.current.close());
    expect(openState()).toBeNull();
    expect(first.result.current.open).toBe(false);
    first.unmount();

    const remounted = renderHook(() => usePendingGatePopoverOpen(FEATURE_ID, true, READY));
    expect(remounted.result.current.open).toBe(false);
    expect(openState()).toBeNull();
  });

  it("opens again for a new request of the same conversation", () => {
    seedPendingGate("request-1");
    const { result } = renderHook(() => usePendingGatePopoverOpen(FEATURE_ID, true, READY));
    act(() => result.current.close());
    expect(result.current.open).toBe(false);

    act(() => seedPendingGate("request-2", FEATURE_ID, 2));
    expect(result.current.open).toBe(true);
  });

  it("doesn't open in click, hover or off mode", () => {
    seedPendingGate();
    for (const gatePopover of ["click", "hover", "off"] as const) {
      useSidebarConfigStore.setState({ config: { ...DEFAULT_SIDEBAR_CONFIG, gatePopover } });
      const { result } = renderHook(() => usePendingGatePopoverOpen(FEATURE_ID, true, READY));
      expect(result.current.open).toBe(false);
    }
  });

  it("leaves a popover the user opened alone, and takes over from an automatic one", () => {
    seedPendingGate("a", 1, 1);
    seedPendingGate("b", 2, 2);
    act(() =>
      usePendingGatePopoverStore
        .getState()
        .openGate({ featureId: 1, surface: "tree", origin: "user" }),
    );
    const newest = renderHook(() => usePendingGatePopoverOpen(2, true, READY));
    expect(newest.result.current.open).toBe(false);
    expect(openState()).toMatchObject({ featureId: 1, origin: "user" });

    act(() => usePendingGatePopoverStore.getState().closeGate());
    expect(openState()).toMatchObject({ featureId: 2, origin: "auto" });
    expect(newest.result.current.open).toBe(true);
  });

  it("lets a new request replace a hovered popover, not one the user opened", () => {
    seedPendingGate("a", 1, 1);
    seedPendingGate("b", 2, 2);
    act(() =>
      usePendingGatePopoverStore
        .getState()
        .openGate({ featureId: 1, surface: "tree", origin: "hover" }),
    );
    renderHook(() => usePendingGatePopoverOpen(2, true, READY));
    expect(openState()).toMatchObject({ featureId: 2, origin: "auto" });
  });

  it("opens on one surface only: a row elsewhere stays shut", () => {
    seedPendingGate();
    act(() =>
      usePendingGatePopoverStore
        .getState()
        .openGate({ featureId: FEATURE_ID, surface: "for-me", origin: "auto" }),
    );
    const { result } = renderHook(() => usePendingGatePopoverOpen(FEATURE_ID, false, READY));
    expect(result.current.open).toBe(false);
  });
});

describe("usePendingGatePopoverOpen closing", () => {
  it("closes when its conversation becomes active, then allows opening it by hand", () => {
    seedPendingGate();
    const { result, rerender } = renderHook(
      ({ isActive }) => usePendingGatePopoverOpen(FEATURE_ID, !isActive, { ...READY, isActive }),
      { initialProps: { isActive: false } },
    );
    expect(result.current.open).toBe(true);

    rerender({ isActive: true });
    expect(openState()).toBeNull();
    expect(result.current.open).toBe(false);

    act(() => result.current.onOpenChange(true));
    expect(result.current.open).toBe(true);
    expect(result.current.origin).toBe("user");
  });

  it("releases its popover when the row goes away while the request still waits", () => {
    seedPendingGate();
    const { unmount } = renderHook(() => usePendingGatePopoverOpen(FEATURE_ID, true, READY));
    expect(openState()).not.toBeNull();
    unmount();
    expect(openState()).toBeNull();
    // Not dismissed: the request may open again where it shows.
    expect(usePendingGatePopoverStore.getState().dismissedRequestIds.size).toBe(0);
  });

  it("leaves an answered request's popover to the host that moves on from it", () => {
    seedPendingGate();
    const { unmount } = renderHook(() => usePendingGatePopoverOpen(FEATURE_ID, true, READY));
    act(() => useSessionStatusStore.setState({ bySession: {} }));
    unmount();
    expect(openState()).toMatchObject({ featureId: FEATURE_ID });
  });
});

describe("usePendingGatePopoverOpen on a phone", () => {
  it("opens the bottom sheet, not a popover, when the icon is tapped", () => {
    mobile.value = true;
    seedPendingGate();
    const { result } = renderHook(() => usePendingGatePopoverOpen(FEATURE_ID, false, READY));
    act(() => result.current.onOpenChange(true));
    expect(openState()).toMatchObject({ featureId: FEATURE_ID, surface: "sheet", origin: "user" });
    // The row itself shows nothing: the sheet is hosted elsewhere.
    expect(result.current.open).toBe(false);
  });
});

describe("usePendingGatePopoverOpen modes", () => {
  it("offers no hover handlers in click mode", () => {
    useSidebarConfigStore.setState({ config: { ...DEFAULT_SIDEBAR_CONFIG, gatePopover: "click" } });
    seedPendingGate();
    const { result } = renderHook(() => usePendingGatePopoverOpen(FEATURE_ID, true, READY));
    expect(result.current.hoverHandlers).toBeUndefined();
  });

  it("opens after a short hover in hover mode and closes once the pointer has left", () => {
    vi.useFakeTimers();
    useSidebarConfigStore.setState({ config: { ...DEFAULT_SIDEBAR_CONFIG, gatePopover: "hover" } });
    seedPendingGate();
    const { result } = renderHook(() => usePendingGatePopoverOpen(FEATURE_ID, true, READY));
    expect(result.current.open).toBe(false);

    act(() => result.current.hoverHandlers?.onPointerEnter());
    act(() => vi.advanceTimersByTime(100));
    expect(result.current.open).toBe(false);
    act(() => vi.advanceTimersByTime(100));
    expect(result.current.open).toBe(true);
    // A hover never takes focus: it is not the user's own open.
    expect(result.current.origin).toBe("hover");

    act(() => result.current.hoverHandlers?.onPointerLeave());
    // Reaching the popover in time keeps it open.
    act(() => result.current.hoverHandlers?.onPointerEnter());
    act(() => vi.advanceTimersByTime(300));
    expect(result.current.open).toBe(true);
    act(() => result.current.hoverHandlers?.onPointerLeave());
    act(() => vi.advanceTimersByTime(300));
    expect(result.current.open).toBe(false);
    // Pointing away isn't dismissing: the request is not remembered as closed.
    expect(usePendingGatePopoverStore.getState().dismissedRequestIds.size).toBe(0);
  });

  it("never lets the pointer take over or close a popover the user opened", () => {
    vi.useFakeTimers();
    useSidebarConfigStore.setState({ config: { ...DEFAULT_SIDEBAR_CONFIG, gatePopover: "hover" } });
    seedPendingGate();
    const { result } = renderHook(() => usePendingGatePopoverOpen(FEATURE_ID, true, READY));
    act(() => result.current.onOpenChange(true));
    expect(result.current.origin).toBe("user");

    act(() => result.current.hoverHandlers?.onPointerEnter());
    act(() => vi.advanceTimersByTime(300));
    expect(result.current.origin).toBe("user");
    act(() => result.current.hoverHandlers?.onPointerLeave());
    act(() => vi.advanceTimersByTime(300));
    expect(result.current.open).toBe(true);
    expect(result.current.origin).toBe("user");
  });
});
