import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_BROWSER_RESPONSIVE_STATE,
  type BrowserResponsiveRequest,
} from "../../src/shared/browser-responsive";
import { BrowserResponsiveController } from "./browser-responsive-controller";
import type { ManagedTab } from "./browser-tab-events";

interface FakeDebugger extends EventEmitter {
  isAttached: ReturnType<typeof vi.fn<() => boolean>>;
  attach: ReturnType<typeof vi.fn>;
  sendCommand: ReturnType<typeof vi.fn>;
}

interface FakeWebContents extends EventEmitter {
  debugger: FakeDebugger;
  executeJavaScriptInIsolatedWorld: ReturnType<typeof vi.fn>;
  getZoomFactor: ReturnType<typeof vi.fn<() => number>>;
  isDestroyed: ReturnType<typeof vi.fn<() => boolean>>;
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function request(overrides: Partial<BrowserResponsiveRequest> = {}): BrowserResponsiveRequest {
  return { ...DEFAULT_BROWSER_RESPONSIVE_STATE, enabled: true, ...overrides };
}

function fixture(options: { enabled?: boolean; zoom?: number; nativeScale?: number } = {}) {
  let destroyed = false;
  let attached = false;
  const debug = Object.assign(new EventEmitter(), {
    isAttached: vi.fn(() => attached),
    attach: vi.fn(() => {
      attached = true;
    }),
    sendCommand: vi.fn(async () => undefined),
  }) as FakeDebugger;
  const webContents = Object.assign(new EventEmitter(), {
    debugger: debug,
    executeJavaScriptInIsolatedWorld: vi.fn(
      async (_worldId: number, scripts: Electron.WebSource[]) => {
        const token = Number(/token: (\d+)/.exec(scripts[0]?.code ?? "")?.[1]);
        if ((scripts[0]?.code ?? "").includes("let resolveOutcome")) {
          return { version: 1, token, kind: "stale" };
        }
        if ((scripts[0]?.code ?? "").includes("guard?.token !==")) {
          return new Promise(() => undefined);
        }
        return { version: 1, token, kind: "stale" };
      },
    ),
    getZoomFactor: vi.fn(() => options.zoom ?? 1),
    isDestroyed: vi.fn(() => destroyed),
  }) as FakeWebContents;
  const tab = {
    metadata: {
      id: "tab-1",
      title: "Example",
      url: "https://example.com/",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      sessionProfileId: "persistent:default",
      isActive: true,
      devToolsOpen: false,
      pinned: false,
      suspended: false,
      zoomPercent: Math.round((options.zoom ?? 1) * 100),
      responsive: { ...DEFAULT_BROWSER_RESPONSIVE_STATE, enabled: options.enabled ?? false },
      scopeId: 7,
    },
    webContents,
  } as unknown as ManagedTab;
  const host = {
    applyLayout: vi.fn(),
    emitState: vi.fn(),
    reportError: vi.fn(),
    nativeScale: vi.fn(
      (_tab: ManagedTab, _request: BrowserResponsiveRequest) => options.nativeScale ?? 0.5,
    ),
  };
  const controller = new BrowserResponsiveController(host);
  controller.watch(tab);
  return {
    controller,
    debug,
    host,
    tab,
    webContents,
    destroy: () => {
      destroyed = true;
      webContents.emit("destroyed");
    },
  };
}

function commands(debug: FakeDebugger, name: string): unknown[] {
  return debug.sendCommand.mock.calls
    .filter(([command]) => command === name)
    .map((call) => call[1]);
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error("Timed out waiting for responsive test operation.");
}

describe("BrowserResponsiveController", () => {
  it("enables mobile metrics, touch and dark appearance on the existing WebContents", async () => {
    const { controller, debug, host, tab } = fixture({ nativeScale: 0.5 });
    const next = request({ colorScheme: "dark" });

    await controller.set(tab, next);

    expect(commands(debug, "Emulation.setDeviceMetricsOverride")).toEqual([
      {
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        mobile: true,
        scale: 0.5,
        screenWidth: 390,
        screenHeight: 844,
        positionX: 0,
        positionY: 0,
      },
    ]);
    expect(commands(debug, "Emulation.setTouchEmulationEnabled")).toEqual([
      { enabled: true, maxTouchPoints: 1 },
    ]);
    expect(commands(debug, "Emulation.setEmitTouchEventsForMouse")).toEqual([
      { enabled: true, configuration: "mobile" },
    ]);
    expect(commands(debug, "Emulation.setEmulatedMedia")).toEqual([
      { media: "", features: [{ name: "prefers-color-scheme", value: "dark" }] },
    ]);
    expect(tab.metadata.responsive).toEqual({ ...next, status: "ready" });
    expect(host.applyLayout).toHaveBeenCalledOnce();
    expect(host.emitState).toHaveBeenCalledWith(7);
  });

  it("compensates desktop metrics for page zoom without coupling mobile mode to touch", async () => {
    const { controller, debug, tab } = fixture({ zoom: 1.25, nativeScale: 0.8 });

    await controller.set(
      tab,
      request({
        preset: "desktop",
        width: 1_280,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
        touch: false,
        colorScheme: "light",
      }),
    );

    expect(commands(debug, "Emulation.setDeviceMetricsOverride")).toEqual([
      {
        width: 1_600,
        height: 1_000,
        deviceScaleFactor: 0.8,
        mobile: false,
        scale: 0.64,
        screenWidth: 1_280,
        screenHeight: 800,
        positionX: 0,
        positionY: 0,
      },
    ]);
    expect(commands(debug, "Emulation.setTouchEmulationEnabled")).toEqual([{ enabled: false }]);
    expect(commands(debug, "Emulation.setEmitTouchEventsForMouse")).toEqual([
      { enabled: false, configuration: "desktop" },
    ]);
  });

  it("clears every override on exit while retaining the last settings", async () => {
    const { controller, debug, tab } = fixture({ enabled: true });
    const disabled = request({ enabled: false, width: 768, height: 1_024, preset: "tablet" });

    await controller.set(tab, disabled);

    expect(commands(debug, "Emulation.clearDeviceMetricsOverride")).toEqual([{}]);
    expect(commands(debug, "Emulation.setTouchEmulationEnabled")).toEqual([{ enabled: false }]);
    expect(commands(debug, "Emulation.setEmitTouchEventsForMouse")).toEqual([
      { enabled: false, configuration: "desktop" },
    ]);
    expect(commands(debug, "Emulation.setEmulatedMedia")).toEqual([{ media: "", features: [] }]);
    expect(tab.metadata.responsive).toEqual({ ...disabled, status: "ready" });
  });

  it("restores the previous state when applying new overrides fails", async () => {
    const { controller, debug, host, tab } = fixture();
    debug.sendCommand.mockRejectedValueOnce(new Error("protocol unavailable"));

    await expect(controller.set(tab, request())).rejects.toThrow("previous settings were restored");

    expect(commands(debug, "Emulation.clearDeviceMetricsOverride")).toEqual([{}]);
    expect(tab.metadata.responsive).toEqual(DEFAULT_BROWSER_RESPONSIVE_STATE);
    expect(host.reportError).not.toHaveBeenCalled();
  });

  it("recomputes the fitted scale when restoring a different enabled preset", async () => {
    const { controller, debug, host, tab } = fixture({ enabled: true });
    tab.metadata.responsive = {
      ...DEFAULT_BROWSER_RESPONSIVE_STATE,
      enabled: true,
      preset: "desktop",
      width: 1_280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
      touch: false,
    };
    host.nativeScale.mockImplementation((_tab, value) => (value.width === 1_280 ? 0.7 : 0.4));
    debug.sendCommand.mockRejectedValueOnce(new Error("new preset failed"));

    await expect(
      controller.set(tab, request({ preset: "tablet", width: 768, height: 1_024 })),
    ).rejects.toThrow("previous settings were restored");

    expect(commands(debug, "Emulation.setDeviceMetricsOverride").at(-1)).toMatchObject({
      screenWidth: 1_280,
      screenHeight: 800,
      scale: 0.7,
    });
    expect(controller.inputScaleGuard(tab)()).toBe(0.7);
    expect(host.applyLayout).toHaveBeenCalledOnce();
  });

  it("fails closed when both rollback and complete cleanup cannot be confirmed", async () => {
    const { controller, debug, host, tab } = fixture();
    debug.sendCommand.mockRejectedValue(new Error("protocol unavailable"));

    await expect(controller.set(tab, request())).rejects.toThrow("rollback failed");

    expect(commands(debug, "Emulation.clearDeviceMetricsOverride")).toHaveLength(2);
    expect(tab.metadata.responsive).toEqual({
      ...DEFAULT_BROWSER_RESPONSIVE_STATE,
      status: "error",
    });
    expect(host.applyLayout).toHaveBeenCalledOnce();
    expect(host.reportError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        issue: {
          kind: "responsiveRollback",
          diagnostics: expect.arrayContaining(["protocol unavailable"]),
        },
      }),
      7,
    );
  });

  it("keeps a native viewport refresh failure as raw diagnostic data", async () => {
    const { controller, debug, host, tab } = fixture({ enabled: true });
    debug.sendCommand.mockRejectedValueOnce(new Error("raw Chromium failure <#1>"));

    controller.syncScale(tab, 0.75);
    await waitUntil(() => host.reportError.mock.calls.length === 1);

    expect(host.reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        issue: {
          kind: "responsiveRecovery",
          context: "viewportSize",
          detail: "raw Chromium failure <#1>",
        },
      }),
      7,
    );
    expect(tab.metadata.responsive.enabled).toBe(false);
  });

  it("reports failed responsive cleanup with the underlying Chromium diagnostics", async () => {
    const { controller, debug, host, tab } = fixture({ enabled: true });
    debug.sendCommand
      .mockRejectedValueOnce(new Error("raw update <#1>"))
      .mockRejectedValueOnce(new Error("raw cleanup <#2>"));

    controller.syncScale(tab, 0.75);
    await waitUntil(() => host.reportError.mock.calls.length === 1);

    expect(host.reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        issue: {
          kind: "responsiveRecovery",
          context: "viewportSize",
          detail: "raw update <#1>",
          cleanupDetail: "raw cleanup <#2>",
        },
      }),
      7,
    );
    expect(tab.metadata.responsive.status).toBe("error");
  });

  it("serializes rapid requests and commits only the newest state", async () => {
    const { controller, debug, tab } = fixture();
    const firstCommand = deferred<void>();
    debug.sendCommand.mockImplementationOnce(() => firstCommand.promise);
    const first = controller.set(tab, request({ width: 390, height: 844 }));
    await flush();
    const newest = request({ width: 412, height: 915, preset: "custom" });
    const second = controller.set(tab, newest);

    firstCommand.resolve();
    await Promise.all([first, second]);

    expect(tab.metadata.responsive).toEqual({ ...newest, status: "ready" });
    expect(commands(debug, "Emulation.setDeviceMetricsOverride").at(-1)).toMatchObject({
      screenWidth: 412,
      screenHeight: 915,
    });
  });

  it("lets a new request supersede a failing stale refresh", async () => {
    const { controller, debug, tab, webContents } = fixture({ enabled: true });
    const refreshCommand = deferred<void>();
    debug.sendCommand.mockImplementationOnce(() => refreshCommand.promise);
    webContents.emit("devtools-opened");
    await flush();

    const newest = request({ width: 412, height: 915, preset: "custom" });
    const update = controller.set(tab, newest);
    refreshCommand.reject(new Error("stale refresh failed"));
    await update;

    expect(tab.metadata.responsive).toEqual({ ...newest, status: "ready" });
    expect(commands(debug, "Emulation.clearDeviceMetricsOverride")).toHaveLength(0);
  });

  it("does not let stale fail-closed cleanup overwrite a request queued during cleanup", async () => {
    const { controller, debug, host, tab, webContents } = fixture({ enabled: true });
    const cleanupCommand = deferred<void>();
    let touchCommands = 0;
    debug.sendCommand.mockImplementation((command: string) => {
      if (command !== "Emulation.setTouchEmulationEnabled") return Promise.resolve();
      touchCommands += 1;
      if (touchCommands === 1) return Promise.reject(new Error("refresh failed"));
      if (touchCommands === 2) return cleanupCommand.promise;
      return Promise.resolve();
    });
    webContents.emit("devtools-opened");
    await waitUntil(() => touchCommands === 2);

    const newest = request({ preset: "custom", width: 412, height: 915 });
    const update = controller.set(tab, newest);
    cleanupCommand.resolve();
    await update;

    expect(tab.metadata.responsive).toEqual({ ...newest, status: "ready" });
    expect(host.reportError).not.toHaveBeenCalled();
  });

  it("reapplies the final fitted scale when layout changes during first activation", async () => {
    const { controller, debug, tab } = fixture({ nativeScale: 0.5 });
    const firstCommand = deferred<void>();
    debug.sendCommand.mockImplementationOnce(() => firstCommand.promise);
    const pending = controller.set(tab, request());
    await flush();

    controller.syncScale(tab, 0.4);
    firstCommand.resolve();
    await pending;

    expect(commands(debug, "Emulation.setDeviceMetricsOverride")).toHaveLength(2);
    expect(commands(debug, "Emulation.setDeviceMetricsOverride").at(-1)).toMatchObject({
      scale: 0.4,
    });
    expect(controller.inputScaleGuard(tab)()).toBe(0.4);
  });

  it("coalesces more than three resize updates without failing closed or starving a new request", async () => {
    const { controller, debug, tab } = fixture({ nativeScale: 0.5 });
    const gates = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()];
    let touchCalls = 0;
    debug.sendCommand.mockImplementation((command: string) => {
      if (command !== "Emulation.setTouchEmulationEnabled" || touchCalls >= gates.length) {
        return Promise.resolve();
      }
      const gate = gates[touchCalls];
      touchCalls += 1;
      return gate.promise;
    });

    const first = controller.set(tab, request());
    const scales = [0.49, 0.48, 0.47];
    for (let index = 0; index < scales.length; index += 1) {
      await waitUntil(() => touchCalls === index + 1);
      controller.syncScale(tab, scales[index]);
      gates[index].resolve();
    }
    await first;
    await waitUntil(() => touchCalls === 4);

    const newest = request({ width: 412, height: 915, preset: "custom" });
    const update = controller.set(tab, newest);
    gates[3].resolve();
    await update;
    await flush();

    expect(tab.metadata.responsive).toEqual({ ...newest, status: "ready" });
    expect(commands(debug, "Emulation.clearDeviceMetricsOverride")).toHaveLength(0);
    expect(controller.inputScaleGuard(tab)()).toBe(0.5);
  });

  it("invalidates asynchronous input guards during every viewport mutation", async () => {
    const { controller, debug, tab } = fixture();
    const command = deferred<void>();
    debug.sendCommand.mockImplementationOnce(() => command.promise);
    const beforeApply = controller.inputScaleGuard(tab);
    const pending = controller.set(tab, request());

    expect(beforeApply).toThrow("viewport changed");
    expect(controller.inputScaleGuard(tab)).toThrow("viewport changed");
    command.resolve();
    await pending;

    const beforeResize = controller.inputScaleGuard(tab);
    controller.syncScale(tab, 0.4);
    expect(beforeResize).toThrow("viewport changed");
    expect(controller.inputScaleGuard(tab)).toThrow("viewport changed");
    await flush();
    expect(controller.inputScaleGuard(tab)()).toBe(0.4);
  });

  it("does not update metadata or call the host after destruction during a failure", async () => {
    const { controller, debug, destroy, host, tab } = fixture();
    const command = deferred<void>();
    debug.sendCommand.mockImplementationOnce(() => command.promise);
    const pending = controller.set(tab, request());
    await flush();

    destroy();
    command.reject(new Error("closed"));
    await expect(pending).resolves.toBe(tab.metadata);

    expect(tab.metadata.responsive).toEqual(DEFAULT_BROWSER_RESPONSIVE_STATE);
    expect(host.applyLayout).not.toHaveBeenCalled();
    expect(host.emitState).not.toHaveBeenCalled();
    expect(host.reportError).not.toHaveBeenCalled();
  });

  it("coalesces repeated DevTools resets and debugger detach recoveries", async () => {
    const { debug, webContents } = fixture({ enabled: true });
    const command = deferred<void>();
    debug.sendCommand.mockImplementationOnce(() => command.promise);

    webContents.emit("devtools-opened");
    webContents.emit("devtools-opened");
    await flush();
    expect(commands(debug, "Emulation.setDeviceMetricsOverride")).toHaveLength(1);
    command.resolve();
    await flush();

    debug.sendCommand.mockClear();
    debug.emit("detach");
    debug.emit("detach");
    await flush();
    expect(commands(debug, "Emulation.setTouchEmulationEnabled")).toHaveLength(1);
  });

  it("reapplies enabled responsive overrides after custom DevTools finishes loading", async () => {
    const { controller, debug, tab } = fixture({ enabled: true });
    tab.metadata = {
      ...tab.metadata,
      responsive: { ...tab.metadata.responsive, colorScheme: "light" },
    };

    controller.devToolsLoaded(tab);
    await flush();

    expect(commands(debug, "Emulation.setDeviceMetricsOverride")).toHaveLength(1);
    expect(commands(debug, "Emulation.setEmulatedMedia")).toEqual([
      { media: "", features: [{ name: "prefers-color-scheme", value: "light" }] },
    ]);
  });

  it("ignores custom DevTools loading while responsive mode is disabled", async () => {
    const { controller, debug, tab } = fixture();

    controller.devToolsLoaded(tab);
    await flush();

    expect(debug.sendCommand).not.toHaveBeenCalled();
  });

  it("ignores a stale custom DevTools load after its Browser tab was destroyed", async () => {
    const { controller, debug, destroy, tab } = fixture({ enabled: true });
    destroy();

    controller.devToolsLoaded(tab);
    await flush();

    expect(debug.sendCommand).not.toHaveBeenCalled();
  });

  it("surfaces a current appearance-guard failure but ignores destroyed contexts", async () => {
    const current = fixture({ enabled: true });
    current.tab.metadata = {
      ...current.tab.metadata,
      responsive: { ...current.tab.metadata.responsive, colorScheme: "light" },
    };
    current.webContents.executeJavaScriptInIsolatedWorld.mockRejectedValueOnce(
      new Error("isolated world unavailable"),
    );
    current.controller.devToolsLoaded(current.tab);
    await waitUntil(() => current.host.reportError.mock.calls.length === 1);
    expect(current.host.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "isolated world unavailable" }),
      7,
    );

    const stale = fixture({ enabled: true });
    stale.tab.metadata = {
      ...stale.tab.metadata,
      responsive: { ...stale.tab.metadata.responsive, colorScheme: "light" },
    };
    stale.webContents.executeJavaScriptInIsolatedWorld.mockRejectedValueOnce(
      new Error("Execution context was destroyed"),
    );
    stale.controller.devToolsLoaded(stale.tab);
    await flush();
    await flush();
    expect(stale.host.reportError).not.toHaveBeenCalled();
  });
});
