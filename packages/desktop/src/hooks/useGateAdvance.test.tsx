// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Feature } from "@/api/generated";
import { SidebarAttentionContext } from "@/components/SidebarAttentionProvider";
import { usePendingGatePopoverStore } from "@/stores/pending-gate-popover-store";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { GATE_ADVANCE_DELAY_MS, nextAfterAnswer, useGateAdvance } from "./useGateAdvance";
import type { ReactNode } from "react";

vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => false }));
vi.mock("@/hooks/useOwnsGateAutoOpen", () => ({ useGateAutoOpenOwner: () => "tree" }));

describe("nextAfterAnswer", () => {
  it("takes the entry after the answered one, else the first still waiting", () => {
    expect(nextAfterAnswer([1, 2, 3], 2, [1, 3])).toBe(3);
    expect(nextAfterAnswer([1, 2, 3], 3, [1, 2])).toBe(1);
    expect(nextAfterAnswer([1, 2, 3], 1, [])).toBeNull();
  });
});

const waiting = (featureId: number, seq: number) =>
  ({ status: "question", kind: "permission", requestId: `r${featureId}`, featureId, seq }) as const;

function attentionWith(featureIds: number[]) {
  return {
    entries: [],
    items: [],
    queue: [],
    byProject: new Map(),
    loadingStates: [],
    actions: featureIds.map((id) => ({
      feature: { id, project_id: 1 } as Feature,
      kind: "waiting" as const,
    })),
    actionsLoading: false,
  };
}

describe("useGateAdvance", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    usePendingGatePopoverStore.setState({
      open: null,
      dismissedRequestIds: new Set(),
      planRequestIds: new Set(),
    });
    useSessionStatusStore.setState({
      bySession: { 1: waiting(1, 1), 2: waiting(2, 2), 3: waiting(3, 3) },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    useSessionStatusStore.setState({ bySession: {} });
  });

  function mount(): void {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SidebarAttentionContext.Provider value={attentionWith(waitingIds())}>
        {children}
      </SidebarAttentionContext.Provider>
    );
    renderHook(() => useGateAdvance(), { wrapper });
  }
  const waitingIds = () =>
    Object.values(useSessionStatusStore.getState().bySession)
      .filter((entry) => entry.status === "question")
      .map((entry) => entry.featureId);

  it("moves a user-opened popover to the next waiting conversation after an answer", () => {
    usePendingGatePopoverStore
      .getState()
      .openGate({ featureId: 1, surface: "tree", origin: "user" });
    mount();
    act(() =>
      useSessionStatusStore.setState({ bySession: { 2: waiting(2, 2), 3: waiting(3, 3) } }),
    );
    act(() => vi.advanceTimersByTime(GATE_ADVANCE_DELAY_MS + 10));
    expect(usePendingGatePopoverStore.getState().open).toMatchObject({
      featureId: 2,
      origin: "user",
    });
  });

  it("just closes an automatic popover once answered", () => {
    usePendingGatePopoverStore
      .getState()
      .openGate({ featureId: 1, surface: "tree", origin: "auto" });
    mount();
    act(() =>
      useSessionStatusStore.setState({ bySession: { 2: waiting(2, 2), 3: waiting(3, 3) } }),
    );
    act(() => vi.advanceTimersByTime(GATE_ADVANCE_DELAY_MS + 10));
    expect(usePendingGatePopoverStore.getState().open).toBeNull();
  });

  it("just closes a hovered popover once answered", () => {
    usePendingGatePopoverStore
      .getState()
      .openGate({ featureId: 1, surface: "tree", origin: "hover" });
    mount();
    act(() =>
      useSessionStatusStore.setState({ bySession: { 2: waiting(2, 2), 3: waiting(3, 3) } }),
    );
    act(() => vi.advanceTimersByTime(GATE_ADVANCE_DELAY_MS + 10));
    expect(usePendingGatePopoverStore.getState().open).toBeNull();
  });

  it("stays on a conversation whose next gate arrives right after the answer", () => {
    usePendingGatePopoverStore
      .getState()
      .openGate({ featureId: 1, surface: "tree", origin: "user" });
    mount();
    act(() => useSessionStatusStore.setState({ bySession: { 2: waiting(2, 2) } }));
    act(() => vi.advanceTimersByTime(GATE_ADVANCE_DELAY_MS - 100));
    act(() =>
      useSessionStatusStore.setState({ bySession: { 1: waiting(1, 9), 2: waiting(2, 2) } }),
    );
    act(() => vi.advanceTimersByTime(GATE_ADVANCE_DELAY_MS));
    expect(usePendingGatePopoverStore.getState().open).toMatchObject({ featureId: 1 });
  });

  it("never touches a display options preview popover", () => {
    usePendingGatePopoverStore
      .getState()
      .openGate({ featureId: -11, surface: "for-me", origin: "auto", preview: true });
    mount();
    act(() => vi.advanceTimersByTime(GATE_ADVANCE_DELAY_MS * 2));
    expect(usePendingGatePopoverStore.getState().open).toMatchObject({ featureId: -11 });
  });
});
