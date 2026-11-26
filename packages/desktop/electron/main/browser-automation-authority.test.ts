import { beforeEach, describe, expect, it, vi } from "vitest";
import { setBrowserOriginPolicyReady, setBrowserRemoteOrigins } from "./runtime-config";
import { BrowserAutomationAuthority } from "./browser-automation-authority";
import { createBrowserProfile } from "./browser-profiles";
import type { ManagedTab } from "./browser-tab-events";
import type { BrowserAgentAccess, BrowserTabMetadata } from "./browser-types";

function managed(
  id: string,
  scopeId: number | null,
  access: BrowserAgentAccess,
  options: {
    url?: string;
    mode?: "persistent" | "fresh" | "feature";
    pinned?: boolean;
    faviconUrl?: string;
    externalAutomationOrigin?: string | null;
    consoleEntries?: ManagedTab["consoleEntries"];
    networkEntries?: ManagedTab["networkEntries"];
  } = {},
): ManagedTab {
  const mode = options.mode ?? "persistent";
  const url = options.url ?? `https://${id}.test`;
  const metadata: BrowserTabMetadata = {
    id,
    title: id,
    url,
    faviconUrl: options.faviconUrl,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    sessionProfileId: mode === "persistent" ? "default" : mode,
    isActive: true,
    devToolsOpen: false,
    pinned: options.pinned ?? false,
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
    profile: createBrowserProfile(mode, mode === "persistent" ? "default" : mode),
    automationAccess: access,
    externalAutomationOrigin: options.externalAutomationOrigin ?? null,
    consoleEntries: options.consoleEntries ?? [],
    networkEntries: options.networkEntries ?? [],
    webContents: {
      mainFrame: { detached: false, framesInSubtree: [] },
      getURL: () => metadata.url,
      isDestroyed: () => false,
    },
  } as unknown as ManagedTab;
}

describe("BrowserAutomationAuthority", () => {
  beforeEach(() => setBrowserRemoteOrigins(["https://tunnel.example.test"]));

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
      tabError: {
        kind: "load" as const,
        title: "Site not found",
        description: "Check private.internal",
        url: "https://private.internal/",
      },
    }));
    const authority = new BrowserAutomationAuthority(tabs, snapshot);

    expect(authority.state(undefined)).toEqual(
      expect.objectContaining({
        tabs: [scopelessAgent.metadata],
        activeTabId: "scopeless-agent",
        error: null,
        tabError: null,
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

  it("keeps user and restored tab page details private until sharing is approved", () => {
    const userHttp = managed("user-http", 7, "user", {
      url: "http://staging.internal/app?private=detail#fragment",
      mode: "persistent",
      pinned: true,
      faviconUrl: "data:image/png;base64,secret",
    });
    const privateUser = managed("user-private", 7, "user", {
      url: "https://private.example.com/",
      mode: "fresh",
    });
    const agentTab = managed("agent-tab", 7, "agent", {
      url: "http://localhost:3000/",
      mode: "feature",
    });
    const blankTab = managed("blank", 7, "user", { url: "about:blank" });
    const fileTab = managed("file", 7, "user", { url: "file:///etc/passwd" });
    const cadencrTab = managed("cadencr", 7, "agent", { url: "http://127.0.0.1:5005/api" });
    const dormantWeb: BrowserTabMetadata = {
      ...userHttp.metadata,
      id: "dormant-web",
      title: "Private restored page",
      url: "https://restored.example.com/private?state=value",
      sessionProfileId: "default",
      isActive: false,
      pinned: false,
      suspended: true,
    };
    const dormantForbidden: BrowserTabMetadata = {
      ...dormantWeb,
      id: "dormant-file",
      url: "file:///private/secret.html",
    };

    const liveTabs = new Map(
      [userHttp, privateUser, agentTab, blankTab, fileTab, cadencrTab].map((tab) => [
        tab.metadata.id,
        tab,
      ]),
    );
    const authority = new BrowserAutomationAuthority(liveTabs, (scopeId) => ({
      scopeId,
      tabs: [
        userHttp.metadata,
        privateUser.metadata,
        agentTab.metadata,
        blankTab.metadata,
        fileTab.metadata,
        cadencrTab.metadata,
        dormantWeb,
        dormantForbidden,
      ],
      activeTabId: "user-http",
      consoleEntries: [],
      networkEntries: [],
      error: null,
    }));

    const listed = authority.listTabs(7);
    expect(listed.scopeId).toBe(7);
    expect(listed.activeTabId).toBe("user-http");
    expect(listed.tabs).toEqual([
      {
        id: "user-http",
        title: "staging.internal",
        url: "http://staging.internal",
        loading: false,
        isActive: true,
        pinned: true,
        suspended: false,
        privacy: "normal",
        agentAccess: "user",
        requiresApproval: true,
      },
      {
        id: "user-private",
        title: "private.example.com",
        url: "https://private.example.com",
        loading: false,
        isActive: true,
        pinned: false,
        suspended: false,
        privacy: "private",
        agentAccess: "user",
        requiresApproval: true,
      },
      {
        id: "agent-tab",
        title: "agent-tab",
        url: "http://localhost:3000/",
        loading: false,
        isActive: true,
        pinned: false,
        suspended: false,
        privacy: "feature",
        agentAccess: "agent",
        requiresApproval: false,
      },
      {
        id: "dormant-web",
        title: "restored.example.com",
        url: "https://restored.example.com",
        loading: false,
        isActive: false,
        pinned: false,
        suspended: true,
        privacy: "normal",
        agentAccess: "user",
        requiresApproval: true,
      },
    ]);
    expect(listed.tabs[0]).not.toHaveProperty("faviconUrl");
    userHttp.automationAccess = "shared";
    expect(authority.listTabs(7).tabs[0]).toMatchObject({
      title: "user-http",
      url: userHttp.metadata.url,
      requiresApproval: false,
    });
  });

  it("fails closed in listTabs and assertApprovable when origin policy is not ready", () => {
    const tab = managed("user-tab", 7, "user", { url: "https://example.com/" });
    const snapshot = vi.fn((scopeId?: number | null) => ({
      scopeId,
      tabs: [tab.metadata],
      activeTabId: "user-tab",
      consoleEntries: [],
      networkEntries: [],
      error: null,
    }));
    const authority = new BrowserAutomationAuthority(new Map([["user-tab", tab]]), snapshot);
    setBrowserOriginPolicyReady(false);

    expect(authority.listTabs(7)).toEqual({ scopeId: 7, activeTabId: null, tabs: [] });
    expect(snapshot).not.toHaveBeenCalled();
    expect(() => authority.assertApprovable("user-tab", 7)).toThrow("cannot inspect");
  });

  it("validates approvable user tabs and only allows about:blank when allowBlank is true", () => {
    const web = managed("web", 7, "user", { url: "http://staging.internal/" });
    const blank = managed("blank", 7, "user", { url: "about:blank" });
    const file = managed("file", 7, "user", { url: "file:///secret.html" });
    const cadencr = managed("cadencr", 7, "user", { url: "https://tunnel.example.test/" });
    const tabs = new Map([web, blank, file, cadencr].map((tab) => [tab.metadata.id, tab]));
    const authority = new BrowserAutomationAuthority(tabs, () => ({
      tabs: [],
      activeTabId: null,
      consoleEntries: [],
      networkEntries: [],
      error: null,
    }));

    expect(authority.assertApprovable("web", 7)).toBe(web);
    expect(() => authority.assertApprovable("web", 8)).toThrow("scope");
    expect(() => authority.assertApprovable("blank", 7, false)).toThrow("cannot inspect");
    expect(authority.assertApprovable("blank", 7, true)).toBe(blank);
    expect(() => authority.assertApprovable("file", 7, true)).toThrow("cannot inspect");
    expect(() => authority.assertApprovable("cadencr", 7, true)).toThrow("cannot inspect");
  });

  it("allows inspecting a shared tab with externalAutomationOrigin on non-loopback http", () => {
    const tab = managed("staging", 7, "shared", {
      url: "http://staging.internal/dashboard",
      externalAutomationOrigin: "http://staging.internal",
    });
    const authority = new BrowserAutomationAuthority(new Map([["staging", tab]]), () => ({
      tabs: [tab.metadata],
      activeTabId: "staging",
      consoleEntries: [],
      networkEntries: [],
      error: null,
    }));
    expect(authority.assert("staging", 7)).toBe(tab);
    expect(authority.isSharedOrAgent("staging", 7)).toBe(true);
    expect(authority.isSharedOrAgent("staging", 8)).toBe(false);
  });

  it("reads per-tab console and network logs including non-loopback HTTP while blocking file/Cadencr URLs", () => {
    const staging = managed("staging", 7, "shared", {
      url: "http://staging.internal/dashboard",
      externalAutomationOrigin: "http://staging.internal",
      consoleEntries: [
        {
          id: "c1",
          tabId: "staging",
          level: "error",
          message: "staging boom",
          sourceUrl: "http://staging.internal/app.js",
          lineNumber: 12,
          timestamp: "",
        },
        {
          id: "c2",
          tabId: "staging",
          level: "error",
          message: "secret file",
          sourceUrl: "file:///etc/passwd",
          lineNumber: 1,
          timestamp: "",
        },
        {
          id: "c3",
          tabId: "staging",
          level: "error",
          message: "cadencr leak",
          sourceUrl: "http://127.0.0.1:5005/api/secret",
          lineNumber: 1,
          timestamp: "",
        },
      ],
      networkEntries: [
        {
          id: "n1",
          tabId: "staging",
          method: "GET",
          url: "http://staging.internal/api/items",
          status: 500,
          requestHeaders: {},
          responseHeaders: {},
          timestamp: "",
        },
        {
          id: "n2",
          tabId: "staging",
          method: "GET",
          url: "http://127.0.0.1:5005/api/secret",
          status: 200,
          requestHeaders: {},
          responseHeaders: {},
          timestamp: "",
        },
      ],
    });
    const authority = new BrowserAutomationAuthority(new Map([["staging", staging]]), () => ({
      tabs: [staging.metadata],
      activeTabId: null,
      consoleEntries: [],
      networkEntries: [],
      error: null,
    }));

    const logs = authority.tabLogs("staging", 7);
    expect(logs.consoleEntries.map((entry) => entry.id)).toEqual(["c1"]);
    expect(logs.networkEntries.map((entry) => entry.id)).toEqual(["n1"]);
  });
});
