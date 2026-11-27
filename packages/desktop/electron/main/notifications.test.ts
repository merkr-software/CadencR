import { uiI18n } from "../../src/shared/ui-i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";

const electronState = vi.hoisted(() => ({
  isPackaged: true,
  isSupported: true,
  showCalls: 0,
  lastOpts: null as { title: string; body: string; silent?: boolean } | null,
  failedHandlers: [] as Array<(event: unknown, error: string) => void>,
  clickHandlers: [] as Array<() => void>,
}));

vi.mock("electron", () => {
  class FakeNotification {
    static isSupported(): boolean {
      return electronState.isSupported;
    }
    constructor(public opts: { title: string; body: string; silent?: boolean }) {
      electronState.lastOpts = opts;
    }
    on(event: "failed" | "click", cb: (...args: never[]) => void): this {
      if (event === "failed") {
        electronState.failedHandlers.push(cb as (event: unknown, error: string) => void);
      } else {
        electronState.clickHandlers.push(cb as () => void);
      }
      return this;
    }
    show(): void {
      electronState.showCalls += 1;
    }
  }
  return {
    Notification: FakeNotification,
    app: {
      get isPackaged() {
        return electronState.isPackaged;
      },
    },
  };
});

import { friendlyFailureReason, sendNotification, sendTestNotification } from "./notifications";

interface FakeWebContents {
  destroyed: boolean;
  send: ReturnType<typeof vi.fn>;
  isDestroyed(): boolean;
}
interface FakeBrowserWindow {
  destroyed: boolean;
  webContents: FakeWebContents;
  isDestroyed(): boolean;
}

function fakeWindow(
  opts: { winDestroyed?: boolean; wcDestroyed?: boolean } = {},
): FakeBrowserWindow {
  const win: FakeBrowserWindow = {
    destroyed: opts.winDestroyed ?? false,
    isDestroyed() {
      return this.destroyed;
    },
    webContents: {
      destroyed: opts.wcDestroyed ?? false,
      send: vi.fn(),
      isDestroyed() {
        return this.destroyed;
      },
    },
  };
  return win;
}

const baseOpts = {
  title: "Done",
  body: "Agent finished",
  featureId: 1,
  projectId: 2,
  routeType: "session" as const,
  mode: "native" as const,
};

beforeEach(() => {
  electronState.isPackaged = true;
  electronState.isSupported = true;
  electronState.showCalls = 0;
  electronState.lastOpts = null;
  electronState.failedHandlers = [];
  electronState.clickHandlers = [];
});

describe("sendNotification — mode: native, packaged", () => {
  it("shows a silent native notification and forwards failures", () => {
    const win = fakeWindow();
    sendNotification(win as unknown as BrowserWindow, baseOpts);

    expect(electronState.showCalls).toBe(1);
    expect(electronState.lastOpts).toEqual({ title: "Done", body: "Agent finished", silent: true });
    expect(electronState.failedHandlers).toHaveLength(1);

    electronState.failedHandlers[0]({}, "denied");
    expect(win.webContents.send).toHaveBeenCalledWith("notification-failed", { reason: "denied" });
  });

  it("forwards click events to the renderer with the route payload", () => {
    const win = fakeWindow();
    sendNotification(win as unknown as BrowserWindow, baseOpts);

    electronState.clickHandlers[0]();
    expect(win.webContents.send).toHaveBeenCalledWith("notification-clicked", {
      feature_id: 1,
      project_id: 2,
      route_type: "session",
    });
  });

  it("emits a synthetic failure when the OS does not support notifications", () => {
    electronState.isSupported = false;
    const win = fakeWindow();
    sendNotification(win as unknown as BrowserWindow, baseOpts);

    expect(electronState.showCalls).toBe(0);
    expect(win.webContents.send).toHaveBeenCalledWith("notification-failed", {
      reason: "Notifications are not supported on this system.",
    });
  });

  it("does not crash if the window is destroyed before the failure fires", () => {
    const win = fakeWindow();
    sendNotification(win as unknown as BrowserWindow, baseOpts);

    win.destroyed = true;
    electronState.failedHandlers[0]({}, "denied");
    expect(win.webContents.send).not.toHaveBeenCalled();
  });

  it("rewrites UNErrorDomain error 1 into a self-explanatory message", () => {
    const win = fakeWindow();
    sendNotification(win as unknown as BrowserWindow, baseOpts);

    electronState.failedHandlers[0](
      {},
      "The operation couldn’t be completed. (UNErrorDomain error 1.)",
    );
    expect(win.webContents.send).toHaveBeenCalledWith(
      "notification-failed",
      expect.objectContaining({
        reason: expect.stringContaining("isn't code-signed"),
      }),
    );
  });

  it("falls back to 'Unknown error' when the failed event has no message", () => {
    const win = fakeWindow();
    sendNotification(win as unknown as BrowserWindow, baseOpts);

    electronState.failedHandlers[0]({}, "");
    expect(win.webContents.send).toHaveBeenCalledWith("notification-failed", {
      reason: "Unknown error",
    });
  });
});

describe("sendNotification — mode: in_app, packaged", () => {
  it("emits an in-app fallback payload and does not construct a Notification", () => {
    const win = fakeWindow();
    sendNotification(win as unknown as BrowserWindow, { ...baseOpts, mode: "in_app" });

    expect(electronState.showCalls).toBe(0);
    expect(electronState.lastOpts).toBeNull();
    expect(win.webContents.send).toHaveBeenCalledWith("notification-fallback", {
      title: "Done",
      body: "Agent finished",
      click: { feature_id: 1, project_id: 2, route_type: "session" },
    });
  });
});

describe("sendNotification — dev override", () => {
  it("forces the in-app fallback even when the renderer asked for native", () => {
    electronState.isPackaged = false;
    const win = fakeWindow();
    sendNotification(win as unknown as BrowserWindow, baseOpts);

    expect(electronState.showCalls).toBe(0);
    expect(electronState.failedHandlers).toHaveLength(0);
    expect(win.webContents.send).toHaveBeenCalledWith("notification-fallback", {
      title: "Done",
      body: "Agent finished",
      click: { feature_id: 1, project_id: 2, route_type: "session" },
    });
  });
});

describe("sendTestNotification", () => {
  it("uses the active native language for test copy and preserves raw OS reasons", async () => {
    uiI18n.addResource(
      "fr",
      "ui",
      "native.notifications.testTitle",
      "Notification de test Cadencr",
    );
    uiI18n.addResource(
      "fr",
      "ui",
      "native.notifications.testBody",
      "Les notifications fonctionnent.",
    );
    await uiI18n.changeLanguage("fr");
    try {
      const win = fakeWindow();
      sendTestNotification(win as unknown as BrowserWindow);
      expect(electronState.lastOpts).toEqual({
        title: "Notification de test Cadencr",
        body: "Les notifications fonctionnent.",
        silent: true,
      });
      electronState.failedHandlers[0]({}, "Raw OS reason");
      expect(win.webContents.send).toHaveBeenCalledWith("notification-failed", {
        reason: "Raw OS reason",
      });
    } finally {
      uiI18n.removeResourceBundle("fr", "ui");
      await uiI18n.changeLanguage("en");
    }
  });

  it("shows a silent native notification and forwards failures (packaged)", () => {
    const win = fakeWindow();
    sendTestNotification(win as unknown as BrowserWindow);

    expect(electronState.showCalls).toBe(1);
    expect(electronState.lastOpts?.silent).toBe(true);
    electronState.failedHandlers[0]({}, "Focus mode");
    expect(win.webContents.send).toHaveBeenCalledWith("notification-failed", {
      reason: "Focus mode",
    });
  });

  it("emits an in-app fallback in dev mode (no click payload)", () => {
    electronState.isPackaged = false;
    const win = fakeWindow();
    sendTestNotification(win as unknown as BrowserWindow);

    expect(electronState.showCalls).toBe(0);
    expect(win.webContents.send).toHaveBeenCalledWith("notification-fallback", {
      title: "Cadencr test notification",
      body: "If you can see this, system notifications are working.",
      click: null,
    });
  });
});

describe("friendlyFailureReason", () => {
  it("rewrites the UNErrorDomain error 1 message", () => {
    const rewritten = friendlyFailureReason(
      "The operation couldn’t be completed. (UNErrorDomain error 1.)",
    );
    expect(rewritten).toContain("code-signed");
  });

  it("also matches the alternate `Code=1` formulation", () => {
    expect(friendlyFailureReason("Error Domain=UNErrorDomain Code=1")).toContain("code-signed");
  });

  it("passes other errors through unchanged", () => {
    expect(friendlyFailureReason("denied")).toBe("denied");
  });

  it("returns a sentinel for empty / undefined errors", () => {
    expect(friendlyFailureReason("")).toBe("Unknown error");
    expect(friendlyFailureReason(undefined)).toBe("Unknown error");
  });
});
