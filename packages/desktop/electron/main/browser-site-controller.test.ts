import type { Session, WebContents } from "electron";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { BrowserSiteApi } from "./browser-site-api";
import { BrowserSiteController, type BrowserSiteTab } from "./browser-site-controller";
import { BrowserSitePermissionStore } from "./browser-site-permission-store";
import { createBrowserProfile } from "./browser-profiles";
import type { ManagedTab } from "./browser-tab-events";

type RequestHandler = NonNullable<Parameters<Session["setPermissionRequestHandler"]>[0]>;
type CheckHandler = NonNullable<Parameters<Session["setPermissionCheckHandler"]>[0]>;

interface FakeBrowser {
  controller: BrowserSiteController;
  session: Session;
  tab: BrowserSiteTab;
  request: RequestHandler;
  check: CheckHandler;
  send: ReturnType<typeof vi.fn>;
  reportError: ReturnType<typeof vi.fn>;
  clearData: ReturnType<typeof vi.fn>;
  cookieRemove: ReturnType<typeof vi.fn>;
  setUrl: (url: string) => void;
}

function fakeBrowser(mode: "fresh" | "persistent" = "fresh"): FakeBrowser {
  let requestHandler: RequestHandler | null = null;
  let checkHandler: CheckHandler | null = null;
  let url = "https://app.example.com/account";
  const clearData = vi.fn(() => Promise.resolve());
  const cookieRemove = vi.fn(() => Promise.resolve());
  const targetSession = {
    setPermissionRequestHandler: vi.fn((handler: RequestHandler | null) => {
      requestHandler = handler;
    }),
    setPermissionCheckHandler: vi.fn((handler: CheckHandler | null) => {
      checkHandler = handler;
    }),
    clearData,
    cookies: {
      get: vi.fn(() =>
        Promise.resolve([
          { name: "app", domain: "app.example.com", path: "/" },
          { name: "shared", domain: ".example.com", path: "/account" },
          { name: "other", domain: "other.test", path: "/" },
        ]),
      ),
      remove: cookieRemove,
    },
  } as unknown as Session;
  const wc = Object.assign(new EventEmitter(), {
    id: 42,
    session: targetSession,
    getURL: () => url,
    isDestroyed: () => false,
  }) as unknown as WebContents;
  const profile = createBrowserProfile(mode, mode === "persistent" ? "default" : "private-1");
  const tab: BrowserSiteTab = {
    metadata: {
      id: "tab-1",
      title: "Account",
      url,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      sessionProfileId: mode === "persistent" ? "default" : "fresh",
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
      scopeId: 7,
    },
    profile,
    automationAccess: "user",
    externalAutomationOrigin: null,
    webContents: wc,
  };
  const send = vi.fn();
  const reportError = vi.fn();
  const controller = new BrowserSiteController({
    send,
    reportError,
    requestTimeoutMs: 5000,
    store: new BrowserSitePermissionStore(`/tmp/cadencr-site-permissions-${process.pid}.json`),
  });
  controller.registerTab(tab);
  if (!requestHandler || !checkHandler) throw new Error("Permission handlers were not installed.");
  return {
    controller,
    session: targetSession,
    tab,
    request: requestHandler,
    check: checkHandler,
    send,
    reportError,
    clearData,
    cookieRemove,
    setUrl: (next) => {
      url = next;
    },
  };
}

describe("BrowserSiteController", () => {
  it("fails closed for unknown permissions, invalid origins, and foreign web contents", () => {
    const browser = fakeBrowser();
    const unknown = vi.fn();
    browser.request(browser.tab.webContents, "notifications", unknown, {
      isMainFrame: true,
      requestingUrl: "https://app.example.com/account",
    });
    expect(unknown).toHaveBeenCalledWith(false);

    const invalid = vi.fn();
    browser.request(browser.tab.webContents, "geolocation", invalid, {
      isMainFrame: true,
      requestingUrl: "about:blank",
    });
    expect(invalid).toHaveBeenCalledWith(false);
    expect(
      browser.check(null, "geolocation", "https://app.example.com", { isMainFrame: true }),
    ).toBe(false);
  });

  it("prompts for a same-origin request and applies the user's decision", () => {
    const browser = fakeBrowser();
    const callback = vi.fn();
    browser.request(browser.tab.webContents, "media", callback, {
      isMainFrame: true,
      requestingUrl: "https://app.example.com/account",
      securityOrigin: "https://app.example.com",
      mediaTypes: ["video", "audio"],
    });
    const request = browser.send.mock.calls[0]?.[1] as { requestId: string };
    expect(browser.send).toHaveBeenCalledWith(
      "browser:permission-request",
      expect.objectContaining({ permissions: ["camera", "microphone"] }),
    );

    browser.controller.resolvePermissionRequest(request.requestId, true);
    expect(callback).toHaveBeenCalledWith(true);
    expect(
      browser.check(browser.tab.webContents, "media", "https://app.example.com", {
        isMainFrame: true,
        mediaType: "video",
      }),
    ).toBe(true);
    expect(
      browser.check(browser.tab.webContents, "media", "https://app.example.com", {
        isMainFrame: true,
        mediaType: "audio",
      }),
    ).toBe(true);
  });

  it("rejects cross-origin embedded frame requests without prompting", () => {
    const browser = fakeBrowser();
    const callback = vi.fn();
    browser.request(browser.tab.webContents, "geolocation", callback, {
      isMainFrame: false,
      requestingUrl: "https://embed.other.test/map",
    });
    expect(callback).toHaveBeenCalledWith(false);
    expect(browser.send).not.toHaveBeenCalled();
    expect(
      browser.check(browser.tab.webContents, "geolocation", "https://embed.other.test", {
        isMainFrame: false,
        embeddingOrigin: "https://app.example.com",
      }),
    ).toBe(false);
  });

  it("cancels pending requests on navigation and keeps sessions fail-closed after close", () => {
    const browser = fakeBrowser();
    const callback = vi.fn();
    browser.request(browser.tab.webContents, "geolocation", callback, {
      isMainFrame: true,
      requestingUrl: "https://app.example.com/account",
    });
    (browser.tab.webContents as unknown as EventEmitter).emit(
      "did-start-navigation",
      {},
      "https://other.test",
      false,
      true,
    );
    expect(callback).toHaveBeenCalledWith(false);
    expect(browser.send).toHaveBeenLastCalledWith(
      "browser:permission-request-cancelled",
      expect.any(Object),
    );

    (browser.tab.webContents as unknown as EventEmitter).emit("destroyed");
    expect(browser.session.setPermissionRequestHandler).not.toHaveBeenLastCalledWith(null);
    expect(browser.session.setPermissionCheckHandler).not.toHaveBeenLastCalledWith(null);
  });

  it("uses the captured webContents id during native destruction", () => {
    const browser = fakeBrowser();
    const contents = browser.tab.webContents as unknown as EventEmitter;

    expect(() => contents.emit("destroyed")).not.toThrow();
    expect(browser.session.setPermissionRequestHandler).not.toHaveBeenLastCalledWith(null);
  });

  it("clears only the current origin in the actual session", async () => {
    const browser = fakeBrowser();
    await browser.controller.clearSiteData(browser.tab, "https://app.example.com");
    expect(browser.clearData).toHaveBeenCalledWith(
      expect.objectContaining({
        origins: ["https://app.example.com"],
        dataTypes: expect.not.arrayContaining(["cookies"]),
      }),
    );
    expect(browser.cookieRemove).toHaveBeenCalledTimes(2);
    expect(browser.cookieRemove).not.toHaveBeenCalledWith(
      expect.stringContaining("other.test"),
      "other",
    );
  });

  it("keeps Private decisions only until the ephemeral session loses its last tab", () => {
    const browser = fakeBrowser("fresh");
    browser.controller.setPermissionDecision(
      browser.tab,
      "https://app.example.com",
      "location",
      "allow",
    );
    expect(browser.controller.info(browser.tab).permissions.location).toBe("allow");

    (browser.tab.webContents as unknown as EventEmitter).emit("destroyed");
    browser.controller.registerTab(browser.tab);

    expect(browser.controller.info(browser.tab).permissions.location).toBe("ask");
  });

  it("denies new permission requests while site-data clearing is in flight", async () => {
    const browser = fakeBrowser();
    let finishClear: () => void = () => {
      throw new Error("Site clear did not start.");
    };
    browser.clearData.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishClear = resolve;
        }),
    );
    const clearing = browser.controller.clearSiteData(browser.tab, "https://app.example.com");
    const callback = vi.fn();
    browser.request(browser.tab.webContents, "geolocation", callback, {
      isMainFrame: true,
      requestingUrl: "https://app.example.com/account",
    });

    expect(callback).toHaveBeenCalledWith(false);
    await vi.waitFor(() => expect(browser.clearData).toHaveBeenCalledOnce());
    finishClear();
    await clearing;
  });

  it("rejects a duplicate clear while the same origin is already clearing", async () => {
    const browser = fakeBrowser();
    let finishClear: () => void = () => {
      throw new Error("Site clear did not start.");
    };
    browser.clearData.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishClear = resolve;
        }),
    );
    const clearing = browser.controller.clearSiteData(browser.tab, "https://app.example.com");

    await expect(
      browser.controller.clearSiteData(browser.tab, "https://app.example.com"),
    ).rejects.toThrow("already being cleared");
    finishClear();
    await clearing;
  });

  it("allows only one pending permission prompt per tab", () => {
    const browser = fakeBrowser();
    const firstCallback = vi.fn();
    const duplicateCallback = vi.fn();
    const details = {
      isMainFrame: true,
      requestingUrl: "https://app.example.com/account",
    };
    browser.request(browser.tab.webContents, "geolocation", firstCallback, details);
    browser.request(browser.tab.webContents, "clipboard-read", duplicateCallback, details);

    expect(browser.send).toHaveBeenCalledOnce();
    expect(firstCallback).not.toHaveBeenCalled();
    expect(duplicateCallback).toHaveBeenCalledWith(false);
    const request = browser.send.mock.calls[0]?.[1] as { requestId: string };
    browser.controller.resolvePermissionRequest(request.requestId, false);
  });

  it("updates metadata.agentAccess, externalAutomationOrigin, emits state on change, and syncs pending access", () => {
    const browser = fakeBrowser();
    const managedTab = browser.tab as unknown as ManagedTab;
    const emitState = vi.fn();
    const syncExternal = vi.fn();
    const api = new BrowserSiteApi(browser.controller, () => managedTab, emitState, syncExternal);

    const sharedInfo = api.setSharing("tab-1", "https://app.example.com", true);
    expect(sharedInfo.agentAccess).toBe("shared");
    expect(managedTab.automationAccess).toBe("shared");
    expect(managedTab.metadata.agentAccess).toBe("shared");
    expect(managedTab.externalAutomationOrigin).toBe("https://app.example.com");
    expect(emitState).toHaveBeenCalledWith(7);
    expect(syncExternal).toHaveBeenCalledWith("tab-1", true);

    // Repeating an identical share does not re-emit state, but still syncs external access.
    api.setSharing("tab-1", "https://app.example.com", true);
    expect(emitState).toHaveBeenCalledTimes(1);

    // Revoking succeeds even after the live URL changed or failed to load.
    browser.setUrl("about:blank");
    const revokedInfo = api.setSharing("tab-1", "https://app.example.com", false);
    expect(revokedInfo.agentAccess).toBe("user");
    expect(managedTab.automationAccess).toBe("user");
    expect(managedTab.metadata.agentAccess).toBe("user");
    expect(managedTab.externalAutomationOrigin).toBeNull();
    expect(emitState).toHaveBeenCalledTimes(2);
    expect(syncExternal).toHaveBeenLastCalledWith("tab-1", false);
  });
});
