import { describe, expect, it, beforeEach } from "vitest";
import { browserTabCount, useBrowserStore } from "./browser-store";
import type { BrowserStateSnapshot } from "@/shared/browser-types";

function snapshot(scopeId: number | null, tabCount: number): BrowserStateSnapshot {
  return {
    scopeId,
    tabs: Array.from({ length: tabCount }, (_, index) => ({
      id: `tab-${scopeId}-${index}`,
      title: "Tab",
      url: "about:blank",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      sessionProfileId: "fresh",
      isActive: index === 0,
      devToolsOpen: false,
      pinned: false,
      suspended: false,
      zoomPercent: 100,
      responsive: {
        enabled: false,
        preset: "mobile",
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        mobile: true,
        touch: true,
        colorScheme: "system",
        status: "ready",
      },
      scopeId,
    })),
    activeTabId: tabCount > 0 ? `tab-${scopeId}-0` : null,
    error: null,
  };
}

describe("useBrowserStore", () => {
  beforeEach(() => {
    useBrowserStore.setState({ snapshot: null, countsByScope: {} });
  });

  it("keeps global tab counts by feature scope separately from active snapshot", () => {
    useBrowserStore.getState().setSnapshot(snapshot(1, 2));
    useBrowserStore.getState().setCountsByScope({ 1: 2, 2: 3 });

    expect(browserTabCount()).toBe(2);
    expect(useBrowserStore.getState().countsByScope[1]).toBe(2);
    expect(useBrowserStore.getState().countsByScope[2]).toBe(3);
  });

  it("skips no-op count updates", () => {
    useBrowserStore.getState().setCountsByScope({ 1: 2 });
    const before = useBrowserStore.getState();

    useBrowserStore.getState().setCountsByScope({ 1: 2 });

    expect(useBrowserStore.getState()).toBe(before);
  });
});
