import type { Display, Rectangle } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_NOTCH_PREFS, type NotchDisplayMode } from "../../src/shared/notch";

const mock = vi.hoisted(() => {
  const windows: MockWindow[] = [];
  class MockWindow {
    destroyed = false;
    readonly webContents = {
      id: windows.length + 1,
      isDestroyed: () => this.destroyed,
      send: vi.fn(),
      on: vi.fn(),
      setZoomFactor: vi.fn(),
    };
    constructor(public bounds: Rectangle) {
      windows.push(this);
    }
    isDestroyed = () => this.destroyed;
    setBounds = vi.fn((bounds: Rectangle) => {
      this.bounds = bounds;
    });
    setAlwaysOnTop = vi.fn();
    setIgnoreMouseEvents = vi.fn();
    once = vi.fn();
    on = vi.fn();
    loadURL = vi.fn(() => Promise.resolve());
    showInactive = vi.fn();
    destroy = vi.fn(() => {
      this.destroyed = true;
    });
  }
  return {
    MockWindow,
    windows,
    displays: [] as Display[],
    primary: null as Display | null,
    listeners: new Map<string, (...args: unknown[]) => void>(),
    cursor: { x: -1000, y: -1000 },
    probe: vi.fn<() => Promise<null>>(() => Promise.resolve(null)),
    preventAppActivation: vi.fn<(win: MockWindow) => void>(),
  };
});

vi.mock("electron", () => ({
  app: {},
  BrowserWindow: mock.MockWindow,
  screen: {
    getAllDisplays: () => mock.displays,
    getPrimaryDisplay: () => mock.primary,
    getCursorScreenPoint: () => mock.cursor,
    on: (name: string, callback: (...args: unknown[]) => void) =>
      mock.listeners.set(name, callback),
    off: (name: string) => mock.listeners.delete(name),
  },
}));
vi.mock("./renderer-window-security", () => ({
  secureWebContents: vi.fn(),
  rendererLoadTarget: () => ({ kind: "url", value: "http://127.0.0.1:1420" }),
}));
vi.mock("./notch-geometry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./notch-geometry")>()),
  probeHardwareNotches: mock.probe,
}));
vi.mock("./notifications", () => ({ sendNotificationClick: vi.fn() }));
vi.mock("./mac-window", () => ({ preventAppActivation: mock.preventAppActivation }));

import { NotchController } from "./notch-window";

const builtIn = {
  id: 1,
  internal: true,
  bounds: { x: -2056, y: 0, width: 2056, height: 1329 },
  workArea: { x: -2056, y: 39, width: 2056, height: 1290 },
} as Display;
const primary = {
  id: 2,
  internal: false,
  bounds: { x: 0, y: 0, width: 2560, height: 1440 },
  workArea: { x: 0, y: 25, width: 2560, height: 1415 },
} as Display;
const notification = {
  id: "preview",
  featureId: null,
  projectId: null,
  status: "completed" as const,
  title: "Your agent finished",
  body: "Preview",
};
let controller: NotchController;
const configure = (displayMode: NotchDisplayMode) =>
  controller.configure({ enabled: true, prefs: { ...DEFAULT_NOTCH_PREFS, displayMode } });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  mock.windows.length = 0;
  mock.displays = [builtIn, primary];
  mock.primary = primary;
  mock.cursor = { x: -1000, y: -1000 };
  mock.probe.mockReset().mockResolvedValue(null);
  mock.preventAppActivation.mockReset();
  controller = new NotchController({ getMainWindow: () => null });
});

afterEach(async () => {
  await controller.setEnabled(false);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("NotchController display lifecycle", () => {
  it("keeps the built-in island when adding both and removes only it for primary", async () => {
    await configure("builtin_always");
    const builtInWindow = mock.windows[0];
    await configure("both");
    expect(mock.windows).toHaveLength(2);
    expect(builtInWindow.destroyed).toBe(false);
    await configure("primary");
    expect(builtInWindow.destroyed).toBe(true);
    expect(mock.windows[1].destroyed).toBe(false);
    expect(mock.windows[1].bounds).toMatchObject({ x: 920, y: 0, width: 720 });
  });

  it("keeps a click on any island from activating the app", async () => {
    await configure("both");
    expect(mock.windows).toHaveLength(2);
    mock.windows.forEach((win, i) =>
      expect(mock.preventAppActivation).toHaveBeenNthCalledWith(i + 1, win),
    );
  });

  it("turns back off when an island's activation guard fails, so a retry works", async () => {
    mock.preventAppActivation.mockImplementationOnce(() => {
      throw new Error("addon missing");
    });
    await expect(configure("primary")).rejects.toThrow("addon missing");
    expect(mock.windows[0].destroyed).toBe(true);
    expect(mock.listeners.size).toBe(0);
    await configure("primary");
    expect(mock.windows).toHaveLength(2);
    expect(mock.windows[1].destroyed).toBe(false);
  });

  it("routes each renderer's ready and hot rect to its own island", async () => {
    await configure("both");
    const [builtInWindow, primaryWindow] = mock.windows;
    expect(controller.markReady(builtInWindow.webContents.id).geometry?.hardware).toBe(true);
    expect(controller.markReady(primaryWindow.webContents.id).geometry?.hardware).toBe(false);
    const rect = { x: 300, y: 0, width: 120, height: 40 };
    controller.setHotRect(builtInWindow.webContents.id, rect);
    controller.setHotRect(primaryWindow.webContents.id, rect);
    mock.cursor = { x: primaryWindow.bounds.x + 350, y: 20 };
    await vi.advanceTimersByTimeAsync(200);
    expect(primaryWindow.webContents.send).toHaveBeenCalledWith("notch:hover", true);
    expect(builtInWindow.webContents.send).not.toHaveBeenCalledWith("notch:hover", true);
    expect(controller.windowForSender(999)).toBeNull();
    expect(() => controller.markReady(999)).toThrow("untrusted");
  });

  it("queues notifications separately until each renderer is ready", async () => {
    await configure("both");
    const [builtInWindow, primaryWindow] = mock.windows;
    controller.markReady(builtInWindow.webContents.id);
    controller.pushNotification(notification);
    expect(builtInWindow.webContents.send).toHaveBeenCalledWith("notch:notification", notification);
    expect(primaryWindow.webContents.send).not.toHaveBeenCalled();
    controller.markReady(primaryWindow.webContents.id);
    expect(primaryWindow.webContents.send).toHaveBeenCalledWith("notch:notification", notification);
    const snapshot = { agents: [] };
    controller.pushSnapshot(snapshot);
    for (const win of mock.windows) {
      expect(win.webContents.send).toHaveBeenCalledWith("notch:snapshot", snapshot);
    }
  });

  it("shares snooze across islands and preserves it when display targets change", async () => {
    await configure("both");
    for (const win of mock.windows) controller.markReady(win.webContents.id);
    controller.snooze(30);
    const until = Date.now() + 30 * 60_000;
    for (const win of mock.windows) {
      expect(win.webContents.send).toHaveBeenCalledWith("notch:snoozed", until);
    }
    const muted = { ...notification, id: "muted", featureId: 1 };
    controller.pushNotification(muted);
    controller.pushNotification(notification);
    for (const win of mock.windows) {
      expect(win.webContents.send).not.toHaveBeenCalledWith("notch:notification", muted);
      expect(win.webContents.send).toHaveBeenCalledWith("notch:notification", notification);
    }
    await configure("primary");
    await configure("builtin_always");
    const rebuilt = mock.windows.at(-1);
    if (!rebuilt) throw new Error("Missing rebuilt island");
    expect(controller.markReady(rebuilt.webContents.id).snoozedUntil).toBe(until);
    controller.snooze(null);
    expect(controller.markReady(rebuilt.webContents.id).snoozedUntil).toBeNull();
  });

  it("drops queued session notifications when snoozing an island that is still loading", async () => {
    await configure("both");
    const muted = { ...notification, id: "muted", featureId: 1 };
    controller.pushNotification(muted);
    controller.pushNotification(notification);
    controller.snooze(5);
    for (const win of mock.windows) {
      controller.markReady(win.webContents.id);
      expect(win.webContents.send).not.toHaveBeenCalledWith("notch:notification", muted);
      expect(win.webContents.send).toHaveBeenCalledWith("notch:notification", notification);
    }
  });

  it.each([
    { width: 0, height: 0 },
    { width: 100, height: 0 },
    { width: 0, height: 8 },
  ])("keeps an empty $width × $height status region click-through", async ({ width, height }) => {
    await configure("primary");
    const win = mock.windows[0];
    controller.markReady(win.webContents.id);
    controller.setHotRect(win.webContents.id, { x: 300, y: 0, width, height });
    mock.cursor = { x: win.bounds.x + 300, y: win.bounds.y };
    await vi.advanceTimersByTimeAsync(200);
    expect(win.webContents.send).not.toHaveBeenCalledWith("notch:hover", true);
  });
  it("retains notifications while the initial display probe is still running", async () => {
    let finishProbe: ((result: null) => void) | undefined;
    mock.probe.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishProbe = resolve;
        }),
    );
    const opening = configure("both");
    await Promise.resolve();
    controller.pushNotification(notification);
    finishProbe?.(null);
    await opening;
    for (const win of mock.windows) {
      controller.markReady(win.webContents.id);
      expect(win.webContents.send).toHaveBeenCalledWith("notch:notification", notification);
    }
  });

  it("reconciles a removed display and destroys all windows on disable", async () => {
    await configure("both");
    const [builtInWindow, primaryWindow] = mock.windows;
    mock.displays = [primary];
    mock.listeners.get("display-removed")?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(builtInWindow.destroyed).toBe(true);
    expect(primaryWindow.destroyed).toBe(false);
    expect(controller.windowForSender(builtInWindow.webContents.id)).toBeNull();
    await controller.setEnabled(false);
    expect(primaryWindow.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(mock.listeners.size).toBe(0);
  });
});
