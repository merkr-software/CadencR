import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setBrowserRemoteOrigins } from "./runtime-config";

const buildContextMenu = vi.hoisted(() =>
  vi.fn((_items: Electron.MenuItemConstructorOptions[]) => ({ popup: vi.fn() })),
);

interface MockWebContents extends EventEmitter {
  id: number;
  session: {
    webRequest: Record<string, unknown>;
    fetch: ReturnType<typeof vi.fn>;
    setPermissionRequestHandler: ReturnType<typeof vi.fn>;
    setPermissionCheckHandler: ReturnType<typeof vi.fn>;
  };
  debugger: EventEmitter & {
    isAttached: () => boolean;
    attach: ReturnType<typeof vi.fn>;
    sendCommand: ReturnType<typeof vi.fn>;
  };
  enableDeviceEmulation: ReturnType<typeof vi.fn>;
  disableDeviceEmulation: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  getURL: ReturnType<typeof vi.fn>;
  getTitle: ReturnType<typeof vi.fn>;
  canGoBack: ReturnType<typeof vi.fn>;
  canGoForward: ReturnType<typeof vi.fn>;
  goBack: ReturnType<typeof vi.fn>;
  goForward: ReturnType<typeof vi.fn>;
  getZoomFactor: ReturnType<typeof vi.fn<() => number>>;
  setZoomFactor: ReturnType<typeof vi.fn>;
  findInPage: ReturnType<typeof vi.fn>;
  stopFindInPage: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  sendInputEvent: ReturnType<typeof vi.fn>;
  insertText: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn<() => boolean>>;
  reload: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  setWindowOpenHandler: ReturnType<typeof vi.fn>;
  setDevToolsWebContents: ReturnType<typeof vi.fn>;
  openDevTools: ReturnType<typeof vi.fn>;
  closeDevTools: ReturnType<typeof vi.fn>;
  inspectElement: ReturnType<typeof vi.fn>;
  executeJavaScript: ReturnType<typeof vi.fn>;
  executeJavaScriptInIsolatedWorld: ReturnType<typeof vi.fn>;
  isLoading: ReturnType<typeof vi.fn>;
}

const webContentsById = new Map<number, MockWebContents>();
const createdViews: Array<{
  setVisible: ReturnType<typeof vi.fn>;
  setBounds: ReturnType<typeof vi.fn>;
  partition?: string;
  webPreferences?: Electron.WebPreferences;
  hasWebContentsOption?: boolean;
}> = [];
const sessionsByPartition = new Map<
  string,
  {
    on: ReturnType<typeof vi.fn>;
    closeAllConnections: ReturnType<typeof vi.fn>;
    clearData: ReturnType<typeof vi.fn>;
    clearAuthCache: ReturnType<typeof vi.fn>;
  }
>();
let nextWebContentsId = 1;
let failNetworkRegistration = false;

vi.mock("electron", () => {
  class WebContentsViewMock {
    private readonly contents: MockWebContents;
    setVisible = vi.fn();
    setBounds = vi.fn();
    partition?: string;
    webPreferences?: Electron.WebPreferences;

    get webContents(): MockWebContents {
      if (this.contents.isDestroyed()) {
        throw new Error("Electron released WebContentsView.webContents");
      }
      return this.contents;
    }

    constructor(options?: {
      webPreferences?: Electron.WebPreferences;
      webContents?: MockWebContents;
    }) {
      this.partition = options?.webPreferences?.partition;
      this.webPreferences = options?.webPreferences;
      (this as (typeof createdViews)[number]).hasWebContentsOption = options
        ? Object.hasOwn(options, "webContents")
        : false;
      createdViews.push(this);
      if (options?.webContents) {
        this.contents = options.webContents;
        return;
      }
      let destroyed = false;
      let zoomFactor = 1;
      let findRequestId = 0;
      const contents = Object.assign(new EventEmitter(), {
        id: nextWebContentsId,
        mainFrame: { detached: false, framesInSubtree: [] },
        session: {
          on: vi.fn(),
          webRequest: {
            onBeforeRequest: vi.fn(),
            onBeforeSendHeaders: vi.fn(() => {
              if (failNetworkRegistration) throw new Error("network registration failed");
            }),
            onCompleted: vi.fn(),
            onErrorOccurred: vi.fn(),
          },
          fetch: vi.fn(
            async () =>
              new Response(new Uint8Array([137, 80, 78, 71]), {
                headers: { "content-type": "image/png" },
              }),
          ),
          setPermissionRequestHandler: vi.fn(),
          setPermissionCheckHandler: vi.fn(),
        },
        debugger: Object.assign(new EventEmitter(), {
          isAttached: () => false,
          attach: vi.fn(),
          sendCommand: vi.fn(),
        }),
        enableDeviceEmulation: vi.fn(),
        disableDeviceEmulation: vi.fn(),
        loadURL: vi.fn(async (url: string) => {
          contents.getURL.mockReturnValue(url);
        }),
        getURL: vi.fn(() => "about:blank"),
        getTitle: vi.fn(() => ""),
        canGoBack: vi.fn(() => false),
        canGoForward: vi.fn(() => false),
        goBack: vi.fn(),
        goForward: vi.fn(),
        getZoomFactor: vi.fn(() => zoomFactor),
        setZoomFactor: vi.fn((factor: number) => {
          zoomFactor = factor;
        }),
        findInPage: vi.fn(() => ++findRequestId),
        stopFindInPage: vi.fn(),
        focus: vi.fn(),
        sendInputEvent: vi.fn(),
        insertText: vi.fn(),
        close: vi.fn(() => {
          if (destroyed) return;
          destroyed = true;
          contents.emit("destroyed");
        }),
        isDestroyed: vi.fn(() => destroyed),
        reload: vi.fn(),
        stop: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        setDevToolsWebContents: vi.fn(),
        openDevTools: vi.fn(),
        closeDevTools: vi.fn(),
        inspectElement: vi.fn(),
        executeJavaScript: vi.fn(),
        executeJavaScriptInIsolatedWorld: vi.fn(async () => []),
        isLoading: vi.fn(() => false),
      }) as MockWebContents;
      nextWebContentsId += 1;
      webContentsById.set(contents.id, contents);
      this.contents = contents;
    }
  }

  return {
    Menu: { buildFromTemplate: buildContextMenu },
    BrowserWindow: class BrowserWindowMock {},
    WebContentsView: WebContentsViewMock,
    session: {
      fromPartition: vi.fn((partition: string) => {
        let target = sessionsByPartition.get(partition);
        if (!target) {
          target = {
            on: vi.fn(),
            closeAllConnections: vi.fn(async () => undefined),
            clearData: vi.fn(async () => undefined),
            clearAuthCache: vi.fn(async () => undefined),
          };
          sessionsByPartition.set(partition, target);
        }
        return target;
      }),
    },
    app: { getPath: vi.fn(() => "/tmp/cadencr-browser-manager-test") },
    shell: { openExternal: vi.fn(async () => undefined) },
  };
});

const { BrowserManager } = await import("./browser-manager");
const { BrowserLibraryController } = await import("./browser-library-controller");
const { WebContentsView } = await import("electron");
type BrowserTabSessionStore = import("./browser-tab-session-store").BrowserTabSessionStore;
type RestorableBrowserScope = import("./browser-tab-session-store").RestorableBrowserScope;

interface MockMainWindow {
  contentView: {
    addChildView: ReturnType<typeof vi.fn>;
    removeChildView: ReturnType<typeof vi.fn>;
  };
  webContents: {
    getZoomFactor: () => number;
    isDestroyed: () => boolean;
    send: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
  };
  getBounds: () => Electron.Rectangle;
  getContentBounds: () => Electron.Rectangle;
  isDestroyed: () => boolean;
}

function mainWindow(): MockMainWindow {
  return {
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    webContents: {
      getZoomFactor: () => 1,
      isDestroyed: () => false,
      send: vi.fn(),
      focus: vi.fn(),
    },
    getBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
    getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
    isDestroyed: () => false,
  };
}

function tabSessionStore(saved: RestorableBrowserScope | null = null): {
  store: BrowserTabSessionStore;
  loadScope: ReturnType<typeof vi.fn>;
  replaceScope: ReturnType<typeof vi.fn>;
} {
  const loadScope = vi.fn(async () => saved);
  const replaceScope = vi.fn(async () => undefined);
  return {
    store: {
      loadScope,
      replaceScope,
      flush: vi.fn(async () => undefined),
    } as unknown as BrowserTabSessionStore,
    loadScope,
    replaceScope,
  };
}

function popupDetails(
  overrides: Partial<Electron.HandlerDetails> & { url: string },
): Electron.HandlerDetails {
  return {
    frameName: "_blank",
    features: "",
    disposition: "foreground-tab",
    referrer: { url: "", policy: "default" },
    ...overrides,
  };
}

function openNativeChild(
  parent: MockWebContents,
  details: Partial<Electron.HandlerDetails> & { url: string },
  options: Electron.BrowserWindowConstructorOptions = {},
): Electron.WindowOpenHandlerResponse {
  parent.emit("before-mouse-event", {}, { type: "mouseDown", button: "left", x: 1, y: 1 });
  const handler = parent.setWindowOpenHandler.mock.calls[0][0] as (
    value: Electron.HandlerDetails,
  ) => Electron.WindowOpenHandlerResponse;
  const response = handler(popupDetails(details));
  response.createWindow?.(options);
  return response;
}

describe("BrowserManager", () => {
  it("installs a context menu whose Inspect action targets the originating tab", () => {
    const win = mainWindow();
    const manager = new BrowserManager(() => win as unknown as Electron.BrowserWindow);
    const first = manager.createTab(undefined, "default", 1);
    const contents = [...webContentsById.values()][0];
    const second = manager.createTab(undefined, "default", 1);
    contents.emit(
      "context-menu",
      { preventDefault: vi.fn() },
      {
        x: 12,
        y: 34,
        linkURL: "",
        misspelledWord: "",
        dictionarySuggestions: [],
        editFlags: {},
      },
    );
    const items = buildContextMenu.mock.calls.at(-1)?.[0];
    const inspect = items?.find((item) => item.label === "Inspect Element");
    expect(inspect).toBeDefined();
    inspect?.click?.(undefined as never, undefined as never, undefined as never);
    expect(contents.inspectElement).toHaveBeenCalledWith(12, 34);
    expect(manager.state(1).tabs.find((tab) => tab.id === first.id)?.devToolsOpen).toBe(true);
    expect(manager.state(1).tabs.find((tab) => tab.id === second.id)?.devToolsOpen).toBe(false);
  });

  beforeEach(() => {
    setBrowserRemoteOrigins([]);
    webContentsById.clear();
    createdViews.length = 0;
    sessionsByPartition.clear();
    nextWebContentsId = 1;
    failNetworkRegistration = false;
    vi.restoreAllMocks();
  });

  it("scales native bounds by the renderer-supplied zoom factor, not the main window's", () => {
    // The main window reports zoom 1, but the renderer measured its bounds at
    // zoom 2. Trusting the renderer's factor keeps the native view aligned with
    // the placeholder even while a zoom change is still propagating to main.
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    manager.createTab(undefined, "fresh", 1);
    const view = createdViews[0];
    view.setBounds.mockClear();

    manager.setBounds({ x: 100, y: 50, width: 300, height: 200 }, 1, 2);

    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 200, y: 100, width: 600, height: 400 });
  });

  it("falls back to the main window zoom factor when the renderer omits one", () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    manager.createTab(undefined, "fresh", 1);
    const view = createdViews[0];
    view.setBounds.mockClear();

    manager.setBounds({ x: 100, y: 50, width: 300, height: 200 }, 1);

    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 100, y: 50, width: 300, height: 200 });
  });

  it("synchronizes main-frame SPA navigation without a title event and ignores subframes", () => {
    const win = mainWindow();
    const manager = new BrowserManager(() => win as unknown as Electron.BrowserWindow);
    const tab = manager.createTab(undefined, "fresh", 1);
    const contents = [...webContentsById.values()][0];
    contents.getURL.mockReturnValue("https://example.com/iframe-route");
    contents.canGoBack.mockReturnValue(true);

    contents.emit("did-navigate-in-page", {}, "https://example.com/iframe-route", false, 2, 3);
    expect(manager.state(1).tabs[0]?.url).toBe("about:blank");

    contents.getURL.mockReturnValue("https://example.com/spa-replaced?test=lot2a");
    contents.emit(
      "did-navigate-in-page",
      {},
      "https://example.com/spa-replaced?test=lot2a",
      true,
      2,
      1,
    );

    expect(manager.state(1).tabs[0]).toMatchObject({
      id: tab.id,
      url: "https://example.com/spa-replaced?test=lot2a",
      canGoBack: true,
    });
  });

  it("correlates find results and drops stale results after navigation", () => {
    const win = mainWindow();
    const manager = new BrowserManager(() => win as unknown as Electron.BrowserWindow);
    const tab = manager.createTab(undefined, "fresh", 1);
    const contents = [...webContentsById.values()][0];
    manager.page.find(tab.id, {
      requestToken: "renderer-request-1",
      query: "cadencrneedle",
      forward: true,
      findNext: true,
    });
    expect(contents.findInPage).toHaveBeenCalledWith("cadencrneedle", {
      forward: true,
      findNext: true,
    });

    contents.emit(
      "found-in-page",
      {},
      {
        requestId: 1,
        activeMatchOrdinal: 1,
        matches: 3,
        selectionArea: { x: 0, y: 0, width: 10, height: 10 },
        finalUpdate: true,
      },
    );
    expect(win.webContents.send).toHaveBeenCalledWith("browser:find-result", {
      tabId: tab.id,
      requestToken: "renderer-request-1",
      activeMatchOrdinal: 1,
      matches: 3,
      finalUpdate: true,
    });

    win.webContents.send.mockClear();
    manager.navigate(tab.id, "https://example.com/next");
    expect(contents.stopFindInPage).toHaveBeenCalledWith("clearSelection");
    contents.emit(
      "found-in-page",
      {},
      {
        requestId: 1,
        activeMatchOrdinal: 2,
        matches: 3,
        selectionArea: { x: 0, y: 0, width: 10, height: 10 },
        finalUpdate: true,
      },
    );
    expect(win.webContents.send).not.toHaveBeenCalledWith("browser:find-result", expect.anything());
  });

  it("reads actual zoom factors for the changed tab and same-origin siblings", () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    const first = manager.createTab(undefined, "fresh", 1);
    manager.createTab(undefined, "fresh", 1);
    const [firstContents, siblingContents] = [...webContentsById.values()];
    siblingContents.getZoomFactor.mockReturnValue(1.2);

    manager.page.zoom(first.id, "in");

    expect(firstContents.setZoomFactor).toHaveBeenCalledWith(1.2);
    expect(manager.state(1).tabs.map((tab) => tab.zoomPercent)).toEqual([120, 120]);

    siblingContents.getZoomFactor.mockReturnValue(1);
    manager.page.zoom(first.id, "reset");
    expect(firstContents.setZoomFactor).toHaveBeenLastCalledWith(1);
    expect(manager.state(1).tabs.map((tab) => tab.zoomPercent)).toEqual([100, 100]);
  });

  it("relays configured find and zoom-reset shortcuts from a focused guest", () => {
    const win = mainWindow();
    const manager = new BrowserManager(() => win as unknown as Electron.BrowserWindow);
    manager.createTab(undefined, "fresh", 1);
    const contents = [...webContentsById.values()][0];
    const primaryModifier = process.platform === "darwin" ? { meta: true } : { control: true };
    manager.page.setGuestShortcutBindings({
      find: { keys: ["mod", "k"] },
      downloads: { keys: ["mod", "shift", "d"] },
      responsive: { keys: ["mod", "shift", "y"] },
      devtools: { keys: ["f12"] },
      zoomReset: { keys: ["mod", "9"] },
      navigateBack: { keys: [] },
      navigateForward: { keys: [] },
    });

    for (const [key, shortcut] of [
      ["k", "find"],
      ["9", "zoom-reset"],
    ] as const) {
      const event = { preventDefault: vi.fn() };
      contents.emit("before-input-event", event, {
        type: "keyDown",
        key,
        code: key === "k" ? "KeyK" : "Digit9",
        meta: false,
        control: false,
        shift: false,
        alt: false,
        ...primaryModifier,
      });
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(win.webContents.send).toHaveBeenCalledWith("browser:shortcut", shortcut);
    }

    const downloadEvent = { preventDefault: vi.fn() };
    contents.emit("before-input-event", downloadEvent, {
      type: "keyDown",
      key: "d",
      code: "KeyZ",
      meta: false,
      control: false,
      shift: true,
      alt: false,
      ...primaryModifier,
    });
    expect(downloadEvent.preventDefault).toHaveBeenCalledOnce();
    expect(win.webContents.send).toHaveBeenCalledWith("browser:shortcut", "downloads");

    const responsiveEvent = { preventDefault: vi.fn() };
    contents.emit("before-input-event", responsiveEvent, {
      type: "keyDown",
      key: "y",
      code: "Semicolon",
      meta: false,
      control: false,
      shift: true,
      alt: false,
      ...primaryModifier,
    });
    expect(responsiveEvent.preventDefault).toHaveBeenCalledOnce();
    expect(win.webContents.send).toHaveBeenCalledWith("browser:shortcut", "responsive");

    const oldResponsiveDefault = { preventDefault: vi.fn() };
    contents.emit("before-input-event", oldResponsiveDefault, {
      type: "keyDown",
      key: "m",
      code: "KeyM",
      meta: false,
      control: false,
      shift: true,
      alt: false,
      ...primaryModifier,
    });
    expect(oldResponsiveDefault.preventDefault).not.toHaveBeenCalled();

    const oldDefaultEvent = { preventDefault: vi.fn() };
    contents.emit("before-input-event", oldDefaultEvent, {
      type: "keyDown",
      key: "j",
      code: "KeyJ",
      meta: false,
      control: false,
      shift: true,
      alt: false,
      ...primaryModifier,
    });
    expect(oldDefaultEvent.preventDefault).not.toHaveBeenCalled();

    const devToolsEvent = { preventDefault: vi.fn() };
    contents.emit("before-input-event", devToolsEvent, {
      type: "keyDown",
      key: "F12",
      code: "F12",
      meta: false,
      control: false,
      shift: false,
      alt: false,
    });
    expect(devToolsEvent.preventDefault).toHaveBeenCalledOnce();
    expect(win.webContents.send).toHaveBeenCalledWith("browser:shortcut", "devtools");
  });

  it("does not relay the responsive default when its binding is disabled", () => {
    const win = mainWindow();
    const manager = new BrowserManager(() => win as unknown as Electron.BrowserWindow);
    manager.createTab(undefined, "fresh", 1);
    const contents = [...webContentsById.values()][0];
    manager.page.setGuestShortcutBindings({
      find: { keys: [] },
      downloads: { keys: [] },
      responsive: { keys: [] },
      devtools: { keys: [] },
      zoomReset: { keys: [] },
      navigateBack: { keys: [] },
      navigateForward: { keys: [] },
    });
    const event = { preventDefault: vi.fn() };

    contents.emit("before-input-event", event, {
      type: "keyDown",
      key: "m",
      code: "KeyM",
      meta: process.platform === "darwin",
      control: process.platform !== "darwin",
      shift: true,
      alt: false,
    });

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(win.webContents.send).not.toHaveBeenCalledWith("browser:shortcut", "responsive");

    const oldDevToolsDefault = { preventDefault: vi.fn() };
    contents.emit("before-input-event", oldDevToolsDefault, {
      type: "keyDown",
      key: "i",
      code: "KeyI",
      meta: process.platform === "darwin",
      control: process.platform !== "darwin",
      shift: false,
      alt: true,
    });
    expect(oldDevToolsDefault.preventDefault).not.toHaveBeenCalled();
    expect(win.webContents.send).not.toHaveBeenCalledWith("browser:shortcut", "devtools");
  });

  it("validates mutating automation against the live WebContents URL", async () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    const tab = manager.createTab("http://localhost:5173/signup");
    const contents = [...webContentsById.values()][0];
    contents.getURL.mockReturnValue("https://example.com/phished");

    await expect(manager.click(tab.id, 10, 20)).rejects.toThrow("localhost");
    expect(contents.sendInputEvent).not.toHaveBeenCalled();
  });

  it("allows localhost mutation and forwards input events", async () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    const tab = manager.createTab("http://localhost:5173/signup");
    const contents = [...webContentsById.values()][0];
    contents.getURL.mockReturnValue("http://localhost:5173/signup");

    await manager.click(tab.id, 10, 20);

    expect(contents.sendInputEvent).toHaveBeenCalledWith({
      type: "mouseDown",
      x: 10,
      y: 20,
      button: "left",
      clickCount: 1,
    });
    expect(contents.sendInputEvent).toHaveBeenCalledWith({
      type: "mouseUp",
      x: 10,
      y: 20,
      button: "left",
      clickCount: 1,
    });
  });

  it("isolates tabs per feature scope", () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    const a = manager.createTab(undefined, "fresh", 1);
    const b = manager.createTab(undefined, "fresh", 2);

    // Each feature only sees — and treats as active — its own tab.
    expect(manager.state(1).tabs.map((t) => t.id)).toEqual([a.id]);
    expect(manager.state(2).tabs.map((t) => t.id)).toEqual([b.id]);
    expect(manager.state(1).activeTabId).toBe(a.id);
    expect(manager.state(2).activeTabId).toBe(b.id);
    // The unscoped (agent/MCP) view still sees every tab.
    expect(
      manager
        .state()
        .tabs.map((t) => t.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
  });

  it("counts open tabs by feature scope", () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    manager.createTab(undefined, "fresh", 1);
    manager.createTab(undefined, "fresh", 1);
    manager.createTab(undefined, "fresh", 2);
    manager.createTab(undefined, "fresh", null);

    expect(manager.tabCountsByScope()).toEqual({ 1: 2, 2: 1 });
  });

  it("emits tab counts only when tab membership changes", async () => {
    const win = mainWindow();
    const manager = new BrowserManager(() => win as unknown as Electron.BrowserWindow);
    const tab = manager.createTab(undefined, "fresh", 1);

    expect(win.webContents.send).toHaveBeenCalledWith("browser:tab-counts", { 1: 1 });
    win.webContents.send.mockClear();

    manager.navigate(tab.id, "http://localhost:1420");
    expect(win.webContents.send).not.toHaveBeenCalledWith("browser:tab-counts", expect.anything());

    await manager.closeTab(tab.id);
    expect(win.webContents.send).toHaveBeenCalledWith("browser:tab-counts", {});
  });

  it("promotes the next tab in the same scope when a feature's active tab closes", async () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    const a1 = manager.createTab(undefined, "fresh", 1);
    const a2 = manager.createTab(undefined, "fresh", 1);
    manager.createTab(undefined, "fresh", 2);

    await manager.closeTab(a2.id);

    // Closing feature 1's active tab falls back to feature 1's other tab, never
    // to feature 2's.
    expect(manager.state(1).tabs.map((t) => t.id)).toEqual([a1.id]);
    expect(manager.state(1).activeTabId).toBe(a1.id);
  });

  it("closes every tab in a scope in one pass, emitting state once", async () => {
    const win = mainWindow();
    const manager = new BrowserManager(() => win as unknown as Electron.BrowserWindow);
    manager.createTab(undefined, "fresh", 1);
    manager.createTab(undefined, "fresh", 1);
    const other = manager.createTab(undefined, "fresh", 2);
    win.webContents.send.mockClear();

    const snapshot = await manager.closeTabsForScope(1);

    // The whole scope is torn down; the other feature is untouched.
    expect(snapshot.tabs).toEqual([]);
    expect(manager.state(1).tabs).toEqual([]);
    expect(manager.state(2).tabs.map((t) => t.id)).toEqual([other.id]);
    // A single batched state push for the scope, not one per closed tab.
    const stateEmits = win.webContents.send.mock.calls.filter(
      ([channel]) => channel === "browser:state",
    );
    expect(stateEmits).toHaveLength(1);
  });

  it("keeps the unscoped (agent/MCP) view active after a scope's last tab closes", async () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    const a = manager.createTab(undefined, "fresh", 1);
    const b = manager.createTab(undefined, "fresh", 2);

    // Closing feature 2's only tab (the most-recently active) must not strand
    // the unscoped view at null — it falls back to the surviving tab.
    expect(manager.state().activeTabId).toBe(b.id);
    await manager.closeTab(b.id);
    expect(manager.state().activeTabId).toBe(a.id);
  });

  it("reuses an explicitly shared scoped tab without changing its profile", async () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    const tab = manager.createTab(undefined, "fresh", 1);
    const contents = [...webContentsById.values()][0];
    contents.getURL.mockReturnValue("http://localhost:3000/start");

    await expect(manager.openUrl("http://localhost:3000/blocked", { scopeId: 1 })).rejects.toThrow(
      "not shared",
    );
    manager.site.setSharing(tab.id, "http://localhost:3000", true);

    const result = await manager.openUrl("http://localhost:3000/next", { scopeId: 1 });

    expect(result.id).toBe(tab.id);
    expect(result.sessionProfileId).toBe("fresh");
    expect(manager.state(1).tabs.map((t) => t.id)).toEqual([tab.id]);
    expect(contents.loadURL).toHaveBeenCalledWith("http://localhost:3000/next");
  });

  it("creates a scoped tab when opening a URL without an active tab", async () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);

    const result = await manager.openUrl("http://localhost:3000/first", { scopeId: 1 });

    expect(manager.state(1).activeTabId).toBe(result.id);
    expect(manager.state(1).tabs.map((t) => t.id)).toEqual([result.id]);
  });

  it("creates a new scoped tab when opening a URL with new_tab", async () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    const first = manager.createTab(undefined, "fresh", 1);

    const second = await manager.openUrl("http://localhost:3000/second", {
      newTab: true,
      scopeId: 1,
    });

    expect(second.id).not.toBe(first.id);
    expect(manager.state(1).tabs.map((t) => t.id)).toEqual([first.id, second.id]);
    expect(manager.state(1).activeTabId).toBe(second.id);
  });

  it("keeps normal browsing on the existing persistent default partition", () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);

    const tab = manager.createTab(undefined, "default", 1);

    expect(tab.sessionProfileId).toBe("default");
    expect(createdViews[0].partition).toBe("persist:browser:default");
    expect(createdViews[0].hasWebContentsOption).toBe(false);
  });

  it("gives separate top-level private tabs separate in-memory partitions", () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);

    const first = manager.createTab(undefined, "fresh", 1);
    const second = manager.createTab(undefined, "fresh", 1);

    expect(first.sessionProfileId).toBe("fresh");
    expect(second.sessionProfileId).toBe("fresh");
    expect(createdViews[0].partition).toMatch(/^browser:fresh:/);
    expect(createdViews[1].partition).toMatch(/^browser:fresh:/);
    expect(createdViews[0].partition).not.toBe(createdViews[1].partition);
  });

  it("makes child private tabs inherit their parent's actual in-memory partition", () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    manager.createTab(undefined, "fresh", 1);
    const parent = [...webContentsById.values()][0];
    openNativeChild(parent, { url: "https://example.com/child" });

    expect(createdViews).toHaveLength(2);
    expect(createdViews[1].partition).toBe(createdViews[0].partition);
    expect(manager.state(1).tabs.map((tab) => tab.sessionProfileId)).toEqual(["fresh", "fresh"]);
  });

  it("keeps modifier and middle-click link tabs in the background", () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    const parentMeta = manager.createTab("https://example.com/", "default", 1);
    const parent = [...webContentsById.values()][0];
    parent.getURL.mockReturnValue("https://example.com/");

    const response = openNativeChild(parent, {
      url: "https://example.com/secondary",
      disposition: "background-tab",
    });

    expect(response.action).toBe("allow");
    expect(manager.state(1).activeTabId).toBe(parentMeta.id);
    expect(manager.state(1).tabs).toHaveLength(2);
    expect(manager.state(1).tabs[1]).toMatchObject({
      url: "https://example.com/secondary",
      isActive: false,
      temporary: undefined,
    });
    const child = [...webContentsById.values()][1];
    expect(child.loadURL).toHaveBeenCalledWith("https://example.com/secondary", {
      httpReferrer: { url: "", policy: "default" },
      postData: undefined,
      extraHeaders: undefined,
    });
  });

  it("preserves native child preferences while enforcing security and exact session", () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    manager.createTab("https://example.com/", "default", 1);
    const parent = [...webContentsById.values()][0];
    parent.getURL.mockReturnValue("https://example.com/");

    const nativeChild = new WebContentsView().webContents as unknown as MockWebContents;
    nativeChild.session = parent.session;
    parent.emit("before-mouse-event", {}, { type: "mouseDown", button: "left", x: 1, y: 1 });
    const handler = parent.setWindowOpenHandler.mock.calls[0][0] as (
      value: Electron.HandlerDetails,
    ) => Electron.WindowOpenHandlerResponse;
    const response = handler(
      popupDetails({
        url: "https://login.example.com/auth",
        frameName: "qa-login",
        disposition: "new-window",
        postBody: {
          contentType: "application/x-www-form-urlencoded",
          data: [{ type: "rawData", bytes: Buffer.from("code=secret") }],
        },
        referrer: { url: "https://example.com/", policy: "strict-origin" },
      }),
    );
    const returned = response.createWindow?.({
      webContents: nativeChild,
      webPreferences: {
        openerId: 321,
        partition: "persist:attacker",
        session: {} as Electron.Session,
        preload: "/tmp/attacker.js",
        nodeIntegration: true,
        nodeIntegrationInWorker: true,
      },
    } as unknown as Electron.BrowserWindowConstructorOptions & {
      webContents: Electron.WebContents;
    });

    const preferences = createdViews[2].webPreferences;
    expect(returned).toBe(nativeChild);
    expect(response.overrideBrowserWindowOptions?.webPreferences).toMatchObject({
      partition: "persist:browser:default",
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    });
    expect(nativeChild.loadURL).not.toHaveBeenCalled();
    expect(preferences).toMatchObject({
      openerId: 321,
      partition: "persist:browser:default",
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
    });
    expect(preferences?.session).toBeUndefined();
    expect(preferences?.preload).toBeUndefined();
    expect(manager.state(1).tabs[1]).toMatchObject({ temporary: true, isActive: true });
  });

  it("allows only one child from a user gesture even after Allow once", () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    const parentMeta = manager.createTab("https://example.com/", "default", 1);
    const parent = [...webContentsById.values()][0];
    parent.getURL.mockReturnValue("https://example.com/");
    const handler = parent.setWindowOpenHandler.mock.calls[0][0] as (
      value: Electron.HandlerDetails,
    ) => Electron.WindowOpenHandlerResponse;

    expect(handler(popupDetails({ url: "https://login.example.com/first" })).action).toBe("deny");
    const blocked = manager.popup.list(1)[0];
    manager.popup.allowOnce(blocked.id);
    parent.emit("before-mouse-event", {}, { type: "mouseDown", button: "left", x: 1, y: 1 });
    const first = handler(popupDetails({ url: "https://login.example.com/first" }));
    expect(first.action).toBe("allow");
    first.createWindow?.({});

    expect(handler(popupDetails({ url: "https://login.example.com/second" })).action).toBe("deny");
    expect(manager.popup.list(1)).toHaveLength(1);
    expect(manager.state(1).tabs).toHaveLength(2);
    expect(manager.state(1).tabs[0].id).toBe(parentMeta.id);
  });

  it("revokes popup grants on navigation and rejects unsafe native targets", () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    manager.createTab("https://example.com/", "default", 1);
    const parent = [...webContentsById.values()][0];
    parent.getURL.mockReturnValue("https://example.com/");
    const handler = parent.setWindowOpenHandler.mock.calls[0][0] as (
      value: Electron.HandlerDetails,
    ) => Electron.WindowOpenHandlerResponse;
    handler(popupDetails({ url: "https://login.example.com/" }));
    manager.popup.allowOnce(manager.popup.list(1)[0].id);

    parent.emit("did-start-navigation", {}, "https://example.com/next", false, true);
    expect(handler(popupDetails({ url: "https://login.example.com/" })).action).toBe("deny");
    parent.emit("before-mouse-event", {}, { type: "mouseDown", button: "left", x: 1, y: 1 });
    expect(handler(popupDetails({ url: "https://user:pass@login.example.com/" })).action).toBe(
      "deny",
    );
    parent.emit("before-mouse-event", {}, { type: "mouseDown", button: "left", x: 1, y: 1 });
    expect(handler(popupDetails({ url: "file:///tmp/secret" })).action).toBe("deny");
  });

  it("keeps temporary auth children out of history, persistence, and closed-tab replay", async () => {
    const history = vi
      .spyOn(BrowserLibraryController.prototype, "recordNavigation")
      .mockImplementation(() => undefined);
    const { store, replaceScope } = tabSessionStore();
    const manager = new BrowserManager(
      () => mainWindow() as unknown as Electron.BrowserWindow,
      store,
    );
    await manager.restoreScopeMetadata(1);
    const parentMeta = manager.createTab("https://example.com/", "default", 1);
    const parent = [...webContentsById.values()][0];
    parent.getURL.mockReturnValue("https://example.com/");
    openNativeChild(parent, {
      url: "https://login.example.com/auth",
      frameName: "qa-login",
      disposition: "new-window",
    });
    const childMeta = manager.state(1).tabs.find((tab) => tab.id !== parentMeta.id);
    if (!childMeta) throw new Error("Expected temporary child");
    const child = [...webContentsById.values()][1];
    child.getURL.mockReturnValue("https://login.example.com/callback");
    child.emit("did-navigate");

    await manager.flushTabSessions();
    expect(history).not.toHaveBeenCalled();
    expect(replaceScope.mock.calls.at(-1)?.[1]?.tabs).toHaveLength(1);
    await manager.closeTab(childMeta.id);
    expect(manager.reopenLastClosedTab(1)).toBeNull();
    expect(manager.state(1).activeTabId).toBe(parentMeta.id);
  });

  it("keeps a chrome-promoted child alive after its original opener closes", async () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    const parentMeta = manager.createTab("https://example.com/", "default", 1);
    const parent = [...webContentsById.values()][0];
    parent.getURL.mockReturnValue("https://example.com/");
    openNativeChild(parent, {
      url: "https://login.example.com/auth",
      frameName: "qa-login",
      disposition: "new-window",
    });
    const childMeta = manager.state(1).tabs.find((tab) => tab.id !== parentMeta.id);
    const child = [...webContentsById.values()][1];
    if (!childMeta || !child) throw new Error("Expected temporary child");
    const openerDestroyedListeners = parent.listenerCount("destroyed");

    manager.navigateFromChrome(childMeta.id, "https://login.example.com/account");

    expect(manager.state(1).tabs.find((tab) => tab.id === childMeta.id)).toMatchObject({
      url: "https://login.example.com/account",
      temporary: undefined,
    });
    expect(parent.listenerCount("destroyed")).toBe(openerDestroyedListeners - 1);

    await manager.closeTab(parentMeta.id);

    expect(child.isDestroyed()).toBe(false);
    expect(manager.state(1).tabs.map((tab) => tab.id)).toEqual([childMeta.id]);
  });

  it("returns focus to a temporary child's opener and releases its parent listener", () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    const parentMeta = manager.createTab("https://example.com/", "default", 1);
    const parent = [...webContentsById.values()][0];
    parent.getURL.mockReturnValue("https://example.com/");
    openNativeChild(parent, {
      url: "https://example.com/secondary-1",
      disposition: "background-tab",
    });
    openNativeChild(parent, {
      url: "https://example.com/secondary-2",
      disposition: "background-tab",
    });
    const baselineListeners = parent.listenerCount("destroyed");
    openNativeChild(parent, {
      url: "https://login.example.com/",
      frameName: "qa-login",
      disposition: "new-window",
    });
    const child = [...webContentsById.values()].at(-1);
    if (!child) throw new Error("Expected auth child");
    expect(manager.state(1).activeTabId).not.toBe(parentMeta.id);
    expect(parent.listenerCount("destroyed")).toBe(baselineListeners + 1);
    void manager.activateTab(parentMeta.id);

    child.emit("focus");
    expect(manager.state(1).activeTabId).toBe(parentMeta.id);
    parent.emit("before-mouse-event", {}, { type: "mouseDown", button: "left", x: 1, y: 1 });
    child.emit("focus");
    expect(manager.state(1).activeTabId).not.toBe(parentMeta.id);

    (child.close as unknown as () => void)();

    expect(manager.state(1).activeTabId).toBe(parentMeta.id);
    expect(parent.listenerCount("destroyed")).toBe(baselineListeners);
  });

  it("preflights the persistent tab cap before returning native allow", async () => {
    const { store } = tabSessionStore();
    const manager = new BrowserManager(
      () => mainWindow() as unknown as Electron.BrowserWindow,
      store,
    );
    await manager.restoreScopeMetadata(1);
    for (let index = 0; index < 100; index += 1) {
      manager.createTab(`https://example.com/${index}`, "default", 1);
    }
    const parent = [...webContentsById.values()][0];
    parent.getURL.mockReturnValue("https://example.com/");
    parent.emit("before-mouse-event", {}, { type: "mouseDown", button: "middle", x: 1, y: 1 });
    const handler = parent.setWindowOpenHandler.mock.calls[0][0] as (
      value: Electron.HandlerDetails,
    ) => Electron.WindowOpenHandlerResponse;

    const response = handler(
      popupDetails({
        url: "https://example.com/overflow",
        disposition: "background-tab",
      }),
    );

    expect(response).toEqual({ action: "deny" });
    expect(createdViews).toHaveLength(100);
    expect(manager.state(1).error).toContain("limited to 100");
  });

  it("does not treat synthetic input or stale input debt as a native popup gesture", async () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    // Exercise a guest app, outside Cadencr's protected renderer origin.
    const tab = manager.createTab("http://localhost:3000/", "default", 1);
    const parent = [...webContentsById.values()][0];
    parent.getURL.mockReturnValue("http://localhost:3000/");
    const handler = parent.setWindowOpenHandler.mock.calls[0][0] as (
      value: Electron.HandlerDetails,
    ) => Electron.WindowOpenHandlerResponse;

    await manager.click(tab.id, 1, 1);
    parent.emit("before-mouse-event", {}, { type: "mouseDown", button: "left", x: 1, y: 1 });
    expect(handler(popupDetails({ url: "http://localhost:3000/synthetic" })).action).toBe("deny");

    await manager.inspection.keypress(tab.id, "Space");
    parent.emit(
      "before-input-event",
      {},
      {
        type: "keyDown",
        key: " ",
        meta: false,
        control: false,
        alt: false,
      },
    );
    expect(handler(popupDetails({ url: "http://localhost:3000/synthetic-space" })).action).toBe(
      "deny",
    );

    await manager.inspection.keypress(tab.id, "A");
    parent.emit(
      "before-input-event",
      {},
      {
        type: "keyDown",
        key: "a",
        meta: false,
        control: false,
        alt: false,
      },
    );
    parent.emit("before-mouse-event", {}, { type: "mouseDown", button: "left", x: 1, y: 1 });
    expect(handler(popupDetails({ url: "http://localhost:3000/human" })).action).toBe("allow");
  });

  it("clears a shared private partition only when its last tab closes", async () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    const parentMeta = manager.createTab(undefined, "fresh", 1);
    const parent = [...webContentsById.values()][0];
    openNativeChild(parent, { url: "https://example.com/child" });
    const childMeta = manager.state(1).tabs.find((tab) => tab.id !== parentMeta.id);
    if (!childMeta) throw new Error("Expected child tab");
    const partition = createdViews[0].partition;
    if (!partition) throw new Error("Expected private partition");

    await manager.closeTab(parentMeta.id);
    expect(sessionsByPartition.has(partition)).toBe(false);

    await manager.closeTab(childMeta.id);
    const privateSession = sessionsByPartition.get(partition);
    expect(privateSession?.closeAllConnections).toHaveBeenCalledOnce();
    expect(privateSession?.clearData).toHaveBeenCalledOnce();
    expect(privateSession?.clearAuthCache).toHaveBeenCalledOnce();
  });

  it("clears every private partition when its feature scope closes", async () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    manager.createTab(undefined, "fresh", 1);
    manager.createTab(undefined, "fresh", 1);
    const partitions = createdViews.map((view) => view.partition);

    await manager.closeTabsForScope(1);

    for (const partition of partitions) {
      if (!partition) throw new Error("Expected private partition");
      expect(sessionsByPartition.get(partition)?.clearData).toHaveBeenCalledOnce();
    }
  });

  it("does not clear the persistent normal partition when its last tab closes", async () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    const tab = manager.createTab(undefined, "default", 1);

    await manager.closeTab(tab.id);

    expect(sessionsByPartition.has("persist:browser:default")).toBe(false);
  });

  it("keeps console lines and requests off the renderer's state broadcast", () => {
    const win = mainWindow();
    const manager = new BrowserManager(() => win as unknown as Electron.BrowserWindow);
    const tab = manager.createTab(undefined, "fresh", 1);
    const contents = [...webContentsById.values()][0];
    const onCompleted = contents.session.webRequest.onCompleted as ReturnType<typeof vi.fn>;
    const completed = onCompleted.mock.calls[0][0] as (details: unknown) => void;
    win.webContents.send.mockClear();

    for (let line = 0; line < 50; line += 1) {
      contents.emit("console-message", {
        level: "info",
        message: `line ${line}`,
        lineNumber: line,
        sourceId: "https://a.test/app.js",
      });
    }
    completed({
      id: 1,
      webContentsId: contents.id,
      method: "GET",
      url: "https://a.test/api",
      statusCode: 200,
      responseHeaders: {},
      resourceType: "xhr",
    });

    const stateEmits = win.webContents.send.mock.calls.filter(
      ([channel]) => channel === "browser:state",
    );
    expect(stateEmits).toEqual([]);
    expect(Object.keys(manager.state(1)).sort()).toEqual(
      ["activeTabId", "error", "scopeId", "tabs"].sort(),
    );
    const automation = manager.automationState(1);
    expect(automation.activeTabId).toBe(tab.id);
    expect(automation.consoleEntries).toHaveLength(50);
    expect(automation.networkEntries.map((entry) => entry.url)).toEqual(["https://a.test/api"]);
  });

  it("materializes favicons through the guest session instead of exposing a remote URL", async () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    manager.createTab(undefined, "fresh", 1);
    const contents = [...webContentsById.values()][0];
    contents.getURL.mockReturnValue("https://private.example/page");

    contents.emit("page-favicon-updated", {}, ["https://private.example/favicon.png"]);

    await vi.waitFor(() =>
      expect(manager.state(1).tabs[0].faviconUrl).toBe("data:image/png;base64,iVBORw=="),
    );
    expect(contents.session.fetch).toHaveBeenCalledWith(
      "https://private.example/favicon.png",
      expect.objectContaining({ credentials: "include", cache: "no-store" }),
    );
  });

  it("recovers the declared favicon when reload does not emit a favicon event", async () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    manager.createTab(undefined, "default", 1);
    const contents = [...webContentsById.values()][0];
    contents.getURL.mockReturnValue("https://example.com/page");
    contents.executeJavaScriptInIsolatedWorld.mockResolvedValue(["https://example.com/icon.svg"]);

    contents.emit("did-start-loading");
    expect(manager.state(1).tabs[0].faviconUrl).toBeUndefined();
    contents.emit("did-stop-loading");

    await vi.waitFor(() =>
      expect(contents.session.fetch).toHaveBeenCalledWith(
        "https://example.com/icon.svg",
        expect.objectContaining({ credentials: "include", cache: "no-store" }),
      ),
    );
    await vi.waitFor(() =>
      expect(manager.state(1).tabs[0].faviconUrl).toBe("data:image/png;base64,iVBORw=="),
    );
  });

  it("does not let a deferred reload query replace a newer favicon event", async () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    manager.createTab(undefined, "default", 1);
    const contents = [...webContentsById.values()][0];
    contents.getURL.mockReturnValue("https://example.com/page");
    let finishQuery: ((urls: string[]) => void) | undefined;
    contents.executeJavaScriptInIsolatedWorld.mockImplementation(
      () => new Promise<string[]>((resolve) => (finishQuery = resolve)),
    );

    contents.emit("did-start-loading");
    contents.emit("did-stop-loading");
    await vi.waitFor(() => expect(finishQuery).toBeTypeOf("function"));
    contents.emit("page-favicon-updated", {}, ["https://example.com/new.png"]);
    finishQuery?.(["https://example.com/stale.png"]);

    await vi.waitFor(() =>
      expect(contents.session.fetch).toHaveBeenCalledWith(
        "https://example.com/new.png",
        expect.any(Object),
      ),
    );
    expect(contents.session.fetch).not.toHaveBeenCalledWith(
      "https://example.com/stale.png",
      expect.any(Object),
    );
  });

  it("does not start deferred favicon recovery after a newer navigation", async () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    manager.createTab(undefined, "default", 1);
    const contents = [...webContentsById.values()][0];
    contents.getURL.mockReturnValue("https://example.com/first");
    let finishQuery: ((urls: string[]) => void) | undefined;
    contents.executeJavaScriptInIsolatedWorld.mockImplementation(
      () => new Promise<string[]>((resolve) => (finishQuery = resolve)),
    );

    contents.emit("did-start-loading");
    contents.emit("did-stop-loading");
    await vi.waitFor(() => expect(finishQuery).toBeTypeOf("function"));
    contents.getURL.mockReturnValue("https://example.com/second");
    contents.emit("did-start-loading");
    finishQuery?.(["https://example.com/stale.png"]);
    await Promise.resolve();

    expect(contents.session.fetch).not.toHaveBeenCalled();
  });

  it("discards a favicon response from a stale navigation", async () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    manager.createTab(undefined, "fresh", 1);
    const contents = [...webContentsById.values()][0];
    contents.getURL.mockReturnValue("https://private.example/first");
    let finishFavicon: ((response: Response) => void) | undefined;
    contents.session.fetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finishFavicon = resolve;
        }),
    );
    contents.emit("page-favicon-updated", {}, ["https://private.example/favicon.png"]);

    contents.getURL.mockReturnValue("https://private.example/second");
    contents.emit("did-start-loading");
    finishFavicon?.(
      new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { "content-type": "image/png" },
      }),
    );
    await vi.waitFor(() => expect(contents.session.fetch).toHaveBeenCalledOnce());
    await new Promise((resolve) => setImmediate(resolve));

    expect(manager.state(1).tabs[0].faviconUrl).toBeUndefined();
  });

  it("waits for native destruction before clearing a private partition", async () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    const tab = manager.createTab(undefined, "fresh", 1);
    const contents = [...webContentsById.values()][0];
    const partition = createdViews[0].partition;
    if (!partition) throw new Error("Expected private partition");
    contents.close.mockImplementation(() => undefined);

    const close = manager.closeTab(tab.id);
    await Promise.resolve();
    expect(sessionsByPartition.has(partition)).toBe(false);

    contents.isDestroyed.mockReturnValue(true);
    contents.emit("destroyed");
    await close;
    expect(sessionsByPartition.get(partition)?.clearData).toHaveBeenCalledOnce();
  });

  it("removes and clears a tab destroyed outside the manager", async () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    manager.createTab(undefined, "fresh", 1);
    const contents = [...webContentsById.values()][0];
    const partition = createdViews[0].partition;
    if (!partition) throw new Error("Expected private partition");

    contents.isDestroyed.mockReturnValue(true);
    contents.emit("destroyed");

    await vi.waitFor(() => expect(manager.state(1).tabs).toEqual([]));
    await vi.waitFor(() =>
      expect(sessionsByPartition.get(partition)?.clearData).toHaveBeenCalledOnce(),
    );
  });

  it("destroys a tab's DevTools contents before clearing its partition", async () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    const tab = manager.createTab(undefined, "fresh", 1);
    manager.toggleDevTools(tab.id);
    const [guest, devtools] = [...webContentsById.values()];

    await manager.closeTab(tab.id);

    expect(devtools.close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
    expect(guest.close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
    expect(createdViews[1].partition).toBe(createdViews[0].partition);
  });

  it("cleans a claimed private session when tab setup fails", async () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    failNetworkRegistration = true;

    expect(() => manager.createTab(undefined, "fresh", 1)).toThrow("network registration failed");

    const contents = [...webContentsById.values()][0];
    const partition = createdViews[0].partition;
    if (!partition) throw new Error("Expected private partition");
    expect(contents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
    await vi.waitFor(() =>
      expect(sessionsByPartition.get(partition)?.clearData).toHaveBeenCalledOnce(),
    );
    expect(manager.state(1).error).toContain("network registration failed");
  });

  it("waits for all scope cleanups before surfacing a cleanup failure", async () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    manager.createTab(undefined, "fresh", 1);
    manager.createTab(undefined, "fresh", 1);
    const [failedPartition, pendingPartition] = createdViews.map((view) => view.partition);
    if (!failedPartition || !pendingPartition) throw new Error("Expected private partitions");
    let finishPending: (() => void) | undefined;
    sessionsByPartition.set(failedPartition, {
      on: vi.fn(),
      closeAllConnections: vi.fn(async () => undefined),
      clearData: vi.fn(async () => {
        throw new Error("clear failed");
      }),
      clearAuthCache: vi.fn(async () => undefined),
    });
    sessionsByPartition.set(pendingPartition, {
      on: vi.fn(),
      closeAllConnections: vi.fn(async () => undefined),
      clearData: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishPending = resolve;
          }),
      ),
      clearAuthCache: vi.fn(async () => undefined),
    });

    const closing = manager.closeTabsForScope(1);
    let settled = false;
    void closing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(finishPending).toBeTypeOf("function"));
    expect(settled).toBe(false);
    finishPending?.();

    await expect(closing).rejects.toThrow("Browser session cleanup failed");
    expect(manager.state(1).error).toContain("Browser session cleanup failed");
  });

  it("drains an aborted favicon fetch before clearing private session data", async () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    const tab = manager.createTab(undefined, "fresh", 1);
    const contents = [...webContentsById.values()][0];
    const partition = createdViews[0].partition;
    if (!partition) throw new Error("Expected private partition");
    contents.getURL.mockReturnValue("https://private.example/page");
    let finishFavicon: ((response: Response) => void) | undefined;
    contents.session.fetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finishFavicon = resolve;
        }),
    );
    contents.emit("page-favicon-updated", {}, ["https://private.example/favicon.png"]);

    const closing = manager.closeTab(tab.id);
    await Promise.resolve();
    expect(sessionsByPartition.has(partition)).toBe(false);
    finishFavicon?.(
      new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { "content-type": "image/png" },
      }),
    );

    await closing;
    expect(sessionsByPartition.get(partition)?.clearData).toHaveBeenCalledOnce();
    expect(manager.state(1).tabs).toEqual([]);
  });

  it("restores only the active normal tab and leaves inactive metadata dormant", async () => {
    const saved: RestorableBrowserScope = {
      tabs: [
        { title: "Pinned", url: "https://one.example/", sessionProfileId: "default", pinned: true },
        { title: "Active", url: "https://two.example/", sessionProfileId: "work", pinned: false },
      ],
      activeIndex: 1,
    };
    const { store, loadScope } = tabSessionStore(saved);
    const manager = new BrowserManager(
      () => mainWindow() as unknown as Electron.BrowserWindow,
      store,
    );

    const [first, second] = (await manager.restoreScope(7)).tabs;

    expect(loadScope).toHaveBeenCalledOnce();
    expect(createdViews).toHaveLength(1);
    expect(first).toMatchObject({ title: "Pinned", pinned: true, suspended: true });
    expect(second).toMatchObject({ title: "Active", isActive: true, suspended: false });
    expect(createdViews[0].partition).toBe("persist:browser:work");
  });

  it("materializes a dormant fallback after the active native tab is destroyed", async () => {
    const { store } = tabSessionStore({
      tabs: [
        {
          title: "Active",
          url: "https://one.example/",
          sessionProfileId: "default",
          pinned: false,
        },
        { title: "Dormant", url: "https://two.example/", sessionProfileId: "work", pinned: false },
      ],
      activeIndex: 0,
    });
    const manager = new BrowserManager(
      () => mainWindow() as unknown as Electron.BrowserWindow,
      store,
    );
    const restored = await manager.restoreScope(7);
    const dormantId = restored.tabs[1].id;
    const activeContents = [...webContentsById.values()][0];

    activeContents.isDestroyed.mockReturnValue(true);
    activeContents.emit("destroyed");

    await vi.waitFor(() => expect(manager.state(7).activeTabId).toBe(dormantId));
    expect(manager.state(7).tabs.find((tab) => tab.id === dormantId)).toMatchObject({
      suspended: false,
      isActive: true,
    });
    expect(createdViews).toHaveLength(2);
  });

  it("does not reactivate a cached restored id after the scope was cleared", async () => {
    const { store, loadScope } = tabSessionStore({
      tabs: [
        {
          title: "Saved",
          url: "https://saved.example/",
          sessionProfileId: "default",
          pinned: false,
        },
      ],
      activeIndex: 0,
    });
    const manager = new BrowserManager(
      () => mainWindow() as unknown as Electron.BrowserWindow,
      store,
    );

    await manager.restoreScope(8);
    await manager.closeTabsForScope(8);

    await expect(manager.restoreScope(8)).resolves.toMatchObject({ tabs: [], activeTabId: null });
    expect(loadScope).toHaveBeenCalledOnce();
  });

  it("retains dormant metadata when materialization fails so activation can retry", async () => {
    const { store } = tabSessionStore({
      tabs: [
        {
          title: "Active",
          url: "https://active.example/",
          sessionProfileId: "default",
          pinned: false,
        },
        {
          title: "Dormant",
          url: "https://dormant.example/",
          sessionProfileId: "work",
          pinned: false,
        },
      ],
      activeIndex: 0,
    });
    const manager = new BrowserManager(
      () => mainWindow() as unknown as Electron.BrowserWindow,
      store,
    );
    const dormantId = (await manager.restoreScope(9)).tabs[1].id;
    failNetworkRegistration = true;

    await expect(manager.activateTab(dormantId)).rejects.toThrow("network registration failed");
    expect(manager.state(9).tabs.find((tab) => tab.id === dormantId)).toMatchObject({
      suspended: true,
    });

    failNetworkRegistration = false;
    await expect(manager.activateTab(dormantId)).resolves.toMatchObject({
      id: dormantId,
      suspended: false,
    });
  });

  it("rejects an invalid new URL without creating a phantom tab", async () => {
    const { store } = tabSessionStore();
    const manager = new BrowserManager(
      () => mainWindow() as unknown as Electron.BrowserWindow,
      store,
    );
    await manager.restoreScope(10);

    expect(() => manager.createTab("javascript:alert(1)", "default", 10)).toThrow();

    expect(manager.state(10).tabs).toEqual([]);
    expect(manager.tabCountsByScope()).toEqual({});
    expect(createdViews).toHaveLength(0);
  });

  it("duplicates a private tab in the same session without inheriting agent sharing", () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    const original = manager.createTab(undefined, "fresh", 11);
    const originalContents = [...webContentsById.values()][0];
    originalContents.getURL.mockReturnValue("http://localhost:3000/");
    manager.site.setSharing(original.id, "http://localhost:3000", true);

    const duplicate = manager.duplicateTab(original.id);

    expect(createdViews[1].partition).toBe(createdViews[0].partition);
    expect(duplicate.pinned).toBe(false);
    expect(() => manager.automation.assert(duplicate.id, 11)).toThrow("not shared");
  });

  it("persists confirmed close-others removals even when private cleanup fails", async () => {
    const { store, replaceScope } = tabSessionStore();
    const manager = new BrowserManager(
      () => mainWindow() as unknown as Electron.BrowserWindow,
      store,
    );
    await manager.restoreScope(12);
    const keep = manager.createTab("https://keep.example/", "default", 12);
    manager.createTab("https://remove.example/", "work", 12);
    manager.createTab(undefined, "fresh", 12);
    const privatePartition = createdViews[2].partition;
    if (!privatePartition) throw new Error("Expected private partition");
    sessionsByPartition.set(privatePartition, {
      on: vi.fn(),
      closeAllConnections: vi.fn(async () => undefined),
      clearData: vi.fn(async () => {
        throw new Error("private cleanup failed");
      }),
      clearAuthCache: vi.fn(async () => undefined),
    });

    await expect(manager.closeOtherTabs(keep.id)).rejects.toThrow("Browser session cleanup failed");
    await manager.flushTabSessions();

    expect(manager.state(12).tabs.map((tab) => tab.id)).toEqual([keep.id]);
    expect(replaceScope).toHaveBeenLastCalledWith(12, {
      tabs: [
        {
          title: "New tab",
          url: "https://keep.example/",
          sessionProfileId: "default",
          pinned: false,
        },
      ],
      activeIndex: 0,
    });
  });

  it("reopens only normal tabs and consumes the stack after successful creation", async () => {
    const { store } = tabSessionStore();
    const manager = new BrowserManager(
      () => mainWindow() as unknown as Electron.BrowserWindow,
      store,
    );
    await manager.restoreScope(13);
    const normal = manager.createTab("https://normal.example/", "default", 13);
    const privateTab = manager.createTab("https://private.example/", "fresh", 13);
    await manager.closeTab(privateTab.id);
    expect(manager.reopenLastClosedTab(13)).toBeNull();
    await manager.closeTab(normal.id);
    failNetworkRegistration = true;
    expect(() => manager.reopenLastClosedTab(13)).toThrow("network registration failed");
    failNetworkRegistration = false;

    expect(manager.reopenLastClosedTab(13)).toMatchObject({
      url: "https://normal.example/",
      sessionProfileId: "default",
    });
    expect(manager.reopenLastClosedTab(13)).toBeNull();
  });

  it("keeps per-scope active flags intact after an unscoped automation snapshot", () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    const first = manager.createTab(undefined, "fresh", 21);
    const second = manager.createTab(undefined, "fresh", 22);

    expect(manager.state().activeTabId).toBe(second.id);

    expect(manager.state(21).tabs.find((tab) => tab.id === first.id)?.isActive).toBe(true);
    expect(manager.state(22).tabs.find((tab) => tab.id === second.id)?.isActive).toBe(true);
  });

  it("groups pinned tabs, bounds reorder within groups, and preserves pins on close others", async () => {
    const manager = new BrowserManager(() => mainWindow() as unknown as Electron.BrowserWindow);
    const first = manager.createTab(undefined, "default", 23);
    const second = manager.createTab(undefined, "default", 23);
    const pinnedPrivate = manager.createTab(undefined, "fresh", 23);
    manager.setTabPinned(pinnedPrivate.id, true);
    manager.setTabPinned(first.id, true);

    manager.reorderTab(first.id, Number.MAX_SAFE_INTEGER);
    expect(manager.state(23).tabs.map((tab) => tab.id)).toEqual([
      pinnedPrivate.id,
      first.id,
      second.id,
    ]);

    await manager.closeOtherTabs(first.id);
    expect(manager.state(23).tabs.map((tab) => tab.id)).toEqual([pinnedPrivate.id, first.id]);
  });

  it("persists the last normal active tab while a private tab is active", async () => {
    const { store, replaceScope } = tabSessionStore();
    const manager = new BrowserManager(
      () => mainWindow() as unknown as Electron.BrowserWindow,
      store,
    );
    await manager.restoreScope(24);
    const first = manager.createTab("https://first.example/", "default", 24);
    manager.createTab("https://second.example/", "work", 24);
    await manager.activateTab(first.id);
    const privateTab = manager.createTab("https://secret.example/", "fresh", 24);
    manager.setTabPinned(privateTab.id, true);

    await manager.flushTabSessions();

    expect(replaceScope).toHaveBeenLastCalledWith(24, expect.objectContaining({ activeIndex: 0 }));
    const saved = replaceScope.mock.lastCall?.[1] as RestorableBrowserScope;
    expect(saved.tabs.map((tab) => tab.url)).toEqual([
      "https://first.example/",
      "https://second.example/",
    ]);
  });

  it("restores metadata-only before destructive scope close without creating a view", async () => {
    const { store } = tabSessionStore({
      tabs: [
        {
          title: "Saved",
          url: "https://saved.example/",
          sessionProfileId: "default",
          pinned: false,
        },
      ],
      activeIndex: 0,
    });
    const manager = new BrowserManager(
      () => mainWindow() as unknown as Electron.BrowserWindow,
      store,
    );

    expect((await manager.restoreScopeMetadata(25)).tabs).toHaveLength(1);
    expect(createdViews).toHaveLength(0);
    await manager.closeTabsForScope(25);
    expect(createdViews).toHaveLength(0);
  });

  it("freezes persistence before native shutdown destruction can erase saved tabs", async () => {
    const { store, replaceScope } = tabSessionStore();
    const manager = new BrowserManager(
      () => mainWindow() as unknown as Electron.BrowserWindow,
      store,
    );
    await manager.restoreScope(26);
    manager.createTab("https://saved.example/", "default", 26);

    await manager.prepareForShutdown();
    const contents = [...webContentsById.values()][0];
    contents.isDestroyed.mockReturnValue(true);
    contents.emit("destroyed");
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(replaceScope).toHaveBeenCalledOnce();
    expect(replaceScope.mock.lastCall?.[1]).toMatchObject({
      tabs: [{ url: "https://saved.example/" }],
    });
  });

  it("detaches live views for a window-only close and reattaches them to the next window", async () => {
    const oldWindow = mainWindow();
    const nextWindow = mainWindow();
    let currentWindow = oldWindow;
    const { store, replaceScope } = tabSessionStore();
    const manager = new BrowserManager(
      () => currentWindow as unknown as Electron.BrowserWindow,
      store,
    );
    await manager.restoreScope(27);
    const tab = manager.createTab("https://kept.example/", "default", 27);
    manager.setBounds({ x: 0, y: 0, width: 500, height: 300 }, 27);
    expect(oldWindow.contentView.addChildView).toHaveBeenCalledOnce();

    await manager.prepareForWindowClose();
    expect(oldWindow.contentView.removeChildView).toHaveBeenCalledOnce();
    currentWindow = nextWindow;
    manager.setBounds({ x: 0, y: 0, width: 500, height: 300 }, 27);

    expect(nextWindow.contentView.addChildView).toHaveBeenCalledOnce();
    expect(manager.state(27).tabs.map((item) => item.id)).toEqual([tab.id]);
    manager.navigate(tab.id, "https://updated.example/");
    await manager.flushTabSessions();
    expect(replaceScope.mock.lastCall?.[1]).toMatchObject({
      tabs: [{ url: "https://updated.example/" }],
    });
  });
});
