import { beforeEach, describe, expect, it } from "vitest";
import { useSidebarProjectOrderStore } from "./sidebar-project-order-store";

function order(): readonly number[] | null {
  return useSidebarProjectOrderStore.getState().order;
}

describe("useSidebarProjectOrderStore", () => {
  beforeEach(() => {
    useSidebarProjectOrderStore.setState({ order: null });
  });

  it("adopts the backend order on the first reconcile (initial load)", () => {
    useSidebarProjectOrderStore.getState().reconcile([3, 1, 2]);
    expect(order()).toEqual([3, 1, 2]);
  });

  it("keeps the frozen order when the backend re-sorts on a background refresh", () => {
    useSidebarProjectOrderStore.getState().reconcile([3, 1, 2]);
    // Backend now ranks project 2 first, but the frozen order must win.
    useSidebarProjectOrderStore.getState().reconcile([2, 3, 1]);
    expect(order()).toEqual([3, 1, 2]);
  });

  it("returns a stable reference when nothing changed", () => {
    useSidebarProjectOrderStore.getState().reconcile([3, 1, 2]);
    const before = order();
    useSidebarProjectOrderStore.getState().reconcile([1, 2, 3]);
    expect(order()).toBe(before);
  });

  it("prepends newly-created projects and drops deleted ones", () => {
    useSidebarProjectOrderStore.getState().reconcile([3, 1, 2]);
    useSidebarProjectOrderStore.getState().reconcile([5, 1, 2]); // 5 added, 3 removed
    expect(order()).toEqual([5, 1, 2]);
  });

  it("re-adopts the fresh backend order on an explicit freeze (manual refresh)", () => {
    useSidebarProjectOrderStore.getState().reconcile([3, 1, 2]);
    useSidebarProjectOrderStore.getState().freeze([2, 1, 3]);
    expect(order()).toEqual([2, 1, 3]);
  });
});
