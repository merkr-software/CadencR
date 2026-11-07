import { beforeEach, describe, expect, it, vi } from "vitest";
import { setBrowserRemoteOrigins } from "./runtime-config";
import { BrowserAutomationAuthority } from "./browser-automation-authority";
import type { ManagedTab } from "./browser-tab-events";
import type { BrowserAgentAccess, BrowserTabMetadata } from "./browser-types";

function managed(id: string, scopeId: number | null, access: BrowserAgentAccess): ManagedTab {
  const metadata: BrowserTabMetadata = {
    id,
    title: id,
    url: `https://${id}.test`,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    sessionProfileId: "default",
    isActive: true,
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
  };
  return {
    metadata,
    automationAccess: access,
    externalAutomationOrigin: null,
    webContents: {
      mainFrame: { detached: false, framesInSubtree: [] },
      getURL: () => metadata.url,
      isDestroyed: () => false,
    },
  } as unknown as ManagedTab;
}

describe("BrowserAutomationAuthority", () => {
  beforeEach(() => setBrowserRemoteOrigins([]));
  it("normalizes an undefined MCP scope to scopeless and sanitizes private state", () => {
    const user = managed("user", 1, "user");
    const featureAgent = managed("feature-agent", 1, "agent");
    const scopelessAgent = managed("scopeless-agent", null, "agent");
    const tabs = new Map([user, featureAgent, scopelessAgent].map((tab) => [tab.metadata.id, tab]));
    const snapshot = vi.fn((scopeId?: number | null) => ({
      scopeId,
      tabs: [...tabs.values()]
        .filter((tab) => tab.metadata.scopeId === scopeId)
        .map((tab) => tab.metadata),
      activeTabId: scopeId === null ? "scopeless-agent" : "feature-agent",
      consoleEntries: [],
      networkEntries: [],
      error: "private failure",
    }));
    const authority = new BrowserAutomationAuthority(tabs, snapshot);

    expect(authority.state(undefined)).toEqual(
      expect.objectContaining({
        tabs: [scopelessAgent.metadata],
        activeTabId: "scopeless-agent",
        error: null,
      }),
    );
    expect(snapshot).toHaveBeenCalledWith(null);
  });

  it("requires exact scope and live per-tab sharing", () => {
    const tab = managed("shared", 7, "shared");
    const authority = new BrowserAutomationAuthority(new Map([["shared", tab]]), () => ({
      tabs: [],
      activeTabId: null,
      consoleEntries: [],
      networkEntries: [],
      error: null,
    }));
    expect(() => authority.assert("shared")).toThrow("scope");
    expect(() => authority.assert("shared", 8)).toThrow("scope");
    const guard = authority.guard("shared", 7);
    tab.automationAccess = "user";
    expect(guard).toThrow("not shared");
  });
});
