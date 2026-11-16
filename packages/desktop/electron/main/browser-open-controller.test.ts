import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserAutomationAuthority } from "./browser-automation-authority";
import type { BrowserInspectionController } from "./browser-inspection-controller";
import { metadataFor } from "./browser-manager-utils";
import { BrowserOpenController } from "./browser-open-controller";
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
  const host = {
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
});
