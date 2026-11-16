// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  takeFocusBeforeUserOpen,
  usePendingGatePopoverStore,
} from "@/stores/pending-gate-popover-store";

const store = usePendingGatePopoverStore;

beforeEach(() => {
  store.setState({ open: null, dismissedRequestIds: new Set(), planRequestIds: new Set() });
});

describe("pending-gate-popover-store", () => {
  it("holds one open popover, named by conversation and surface", () => {
    store.getState().openGate({ featureId: 1, surface: "for-me", origin: "auto" });
    store.getState().openGate({ featureId: 2, surface: "tree", origin: "user" });
    expect(store.getState().open).toEqual({
      featureId: 2,
      surface: "tree",
      origin: "user",
      preview: false,
    });
  });

  it("keeps the same state object when reopening the same popover", () => {
    store.getState().openGate({ featureId: 1, surface: "tree", origin: "auto" });
    const before = store.getState();
    store.getState().openGate({ featureId: 1, surface: "tree", origin: "auto" });
    expect(store.getState()).toBe(before);
  });

  it("remembers a closed request, and a plain close remembers nothing", () => {
    store.getState().openGate({ featureId: 1, surface: "tree", origin: "auto" });
    store.getState().closeGate("req-1");
    expect(store.getState().open).toBeNull();
    expect(store.getState().dismissedRequestIds.has("req-1")).toBe(true);

    store.getState().openGate({ featureId: 1, surface: "tree", origin: "user" });
    store.getState().closeGate();
    expect(store.getState().dismissedRequestIds.size).toBe(1);
  });

  it("forgets the oldest dismissals past its bound", () => {
    for (let i = 0; i < 250; i++) store.getState().closeGate(`req-${i}`);
    const dismissed = store.getState().dismissedRequestIds;
    expect(dismissed.size).toBe(200);
    expect(dismissed.has("req-0")).toBe(false);
    expect(dismissed.has("req-249")).toBe(true);
  });

  it("releases only the popover it names, without dismissing", () => {
    store.getState().openGate({ featureId: 1, surface: "tree", origin: "user" });
    store.getState().releaseGate(1, "for-me");
    expect(store.getState().open).not.toBeNull();
    store.getState().releaseGate(1, "tree");
    expect(store.getState().open).toBeNull();
    expect(store.getState().dismissedRequestIds.size).toBe(0);
  });

  it("forgets the oldest plan requests past its bound", () => {
    for (let i = 0; i < 250; i++) store.getState().markPlanRequest(`plan-${i}`, true);
    const planned = store.getState().planRequestIds;
    expect(planned.size).toBe(200);
    expect(planned.has("plan-0")).toBe(false);
    expect(planned.has("plan-249")).toBe(true);
  });

  it("remembers what had focus when the user opens, not when it opens by itself or on hover", () => {
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    store.getState().openGate({ featureId: 1, surface: "tree", origin: "hover" });
    expect(takeFocusBeforeUserOpen()).toBeNull();

    store.getState().openGate({ featureId: 1, surface: "tree", origin: "user" });
    // The queue's arrows switch conversations: the first element still counts.
    document.body.focus();
    store.getState().openGate({ featureId: 2, surface: "tree", origin: "user" });
    expect(takeFocusBeforeUserOpen()).toBe(field);
    expect(takeFocusBeforeUserOpen()).toBeNull();
    field.remove();
  });

  it("tracks which requests are plans", () => {
    store.getState().markPlanRequest("plan-1", true);
    expect(store.getState().planRequestIds.has("plan-1")).toBe(true);
    store.getState().markPlanRequest("plan-1", false);
    expect(store.getState().planRequestIds.has("plan-1")).toBe(false);
  });
});
