import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserAutomationAuthority } from "./browser-automation-authority";
import type { BrowserInspectionController } from "./browser-inspection-controller";
import { metadataFor } from "./browser-manager-utils";
import { BrowserOpenController, type BrowserOpenHost } from "./browser-open-controller";
import { setBrowserRemoteOrigins } from "./runtime-config";
import type { ManagedTab } from "./browser-tab-events";

function opener(finalUrl: string) {
  let liveUrl = "about:blank";
  const tab = {
    metadata: metadataFor("tab", "fresh", 7),
    automationAccess: "agent",
    externalAutomationOrigin: null,
    webContents: {
      mainFrame: { detached: false, framesInSubtree: [] },
      getURL: () => liveUrl,
      isDestroyed: () => false,
    },
  } as unknown as ManagedTab;
  const authority = new BrowserAutomationAuthority(new Map([["tab", tab]]), () => ({
    tabs: [tab.metadata],
    activeTabId: "tab",
    consoleEntries: [],
    networkEntries: [],
    error: null,
  }));
  const navigate = vi.fn((_id: string, url: string) => {
    liveUrl = url;
    tab.metadata = { ...tab.metadata, url };
    return tab.metadata;
  });
  const host: BrowserOpenHost & {
    navigate: typeof navigate;
    createAgentTab: ReturnType<typeof vi.fn>;
  } = {
    activeTabId: () => null,
    navigate,
    createAgentTab: vi.fn((url: string) => navigate("tab", url)),
    requireTab: () => tab,
  };
  const inspection = {
    waitForLoad: vi.fn(async () => {
      liveUrl = finalUrl;
      tab.metadata = { ...tab.metadata, url: finalUrl };
    }),
  } as unknown as BrowserInspectionController;
  return { controller: new BrowserOpenController(authority, inspection, host), tab, host };
}

beforeEach(() => setBrowserRemoteOrigins(["https://tunnel.example.test"]));

describe("agent URL opening", () => {
  it.each([
    "file:///private/secret.html",
    "http://localhost:5005/",
    "https://tunnel.example.test/",
  ])("rejects %s before creating a tab, even with external approval", async (url) => {
    const { controller, host } = opener(url);
    await expect(controller.open(url, { scopeId: 7 })).rejects.toThrow();
    await expect(controller.openExternal(url, { scopeId: 7 })).rejects.toThrow();
    expect(host.createAgentTab).not.toHaveBeenCalled();
  });

  it("does not convert an approved site's redirect into approval for another site", async () => {
    const { controller, tab } = opener("https://unapproved.test/private");
    await expect(controller.openExternal("https://approved.test/", { scopeId: 7 })).rejects.toThrow(
      "outside the approved origin",
    );
    expect(tab.externalAutomationOrigin).toBeNull();
  });

  it("rejects a localhost redirect into Cadencr", async () => {
    const { controller } = opener("http://127.0.0.1:5005/api/settings");
    await expect(controller.open("http://localhost:3000/", { scopeId: 7 })).rejects.toThrow(
      "outside Cadencr",
    );
  });

  it("retains external automation only for the requested origin", async () => {
    const { controller, tab } = opener("https://approved.test/dashboard");
    await expect(
      controller.openExternal("https://approved.test/", { scopeId: 7 }),
    ).resolves.toMatchObject({ url: "https://approved.test/dashboard" });
    expect(tab.externalAutomationOrigin).toBe("https://approved.test");
  });

  it("skips ensureAgentAccess when replacing an already-shared or agent tab and updates externalAutomationOrigin before navigate", async () => {
    const { controller, tab, host } = opener("http://localhost:3000/ready");
    tab.automationAccess = "shared";
    tab.metadata = { ...tab.metadata, url: "https://previous.example.com/" };
    tab.externalAutomationOrigin = "https://previous.example.com";
    const ensureAgentAccess = vi.fn(async () => undefined);
    let originAtNavigate: string | null = null;
    host.ensureAgentAccess = ensureAgentAccess;
    host.navigate.mockImplementation((_id: string, url: string) => {
      originAtNavigate = tab.externalAutomationOrigin;
      tab.metadata = { ...tab.metadata, url };
      return tab.metadata;
    });

    await expect(
      controller.open("http://localhost:3000/ready", { scopeId: 7, tabId: "tab" }),
    ).resolves.toMatchObject({ url: "http://localhost:3000/ready" });
    expect(ensureAgentAccess).not.toHaveBeenCalled();
    expect(originAtNavigate).toBe("http://localhost:3000");
  });

  it("prompts via ensureAgentAccess with allowBlank, targetUrl, and signal for an unshared user tab", async () => {
    const { controller, tab, host } = opener("http://localhost:3000/app");
    tab.automationAccess = "user";
    const abort = new AbortController();
    const ensureAgentAccess = vi.fn(async () => {
      tab.automationAccess = "shared";
    });
    host.ensureAgentAccess = ensureAgentAccess;

    await controller.open("http://localhost:3000/app", { scopeId: 7, tabId: "tab" }, abort.signal);
    expect(ensureAgentAccess).toHaveBeenCalledWith("tab", 7, {
      allowBlank: true,
      targetUrl: "http://localhost:3000/app",
      signal: abort.signal,
    });
  });
});
