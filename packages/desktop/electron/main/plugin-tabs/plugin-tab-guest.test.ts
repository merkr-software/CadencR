import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "electron";

interface MockContents extends EventEmitter {
  destroyed: boolean;
  loadURL: ReturnType<typeof vi.fn>;
  setWindowOpenHandler: ReturnType<typeof vi.fn>;
  setWebRTCIPHandlingPolicy: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
  close: ReturnType<typeof vi.fn>;
}

const created = vi.hoisted(
  () =>
    [] as Array<{
      webPreferences: Electron.WebPreferences;
      setBackgroundColor: ReturnType<typeof vi.fn>;
      webContents: MockContents;
    }>,
);
const loadResult = vi.hoisted(() => ({ next: Promise.resolve() as Promise<void> }));

vi.mock("electron", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  class WebContentsViewMock {
    webPreferences: Electron.WebPreferences;
    setBackgroundColor = vi.fn();
    webContents: MockContents;
    constructor(options: { webPreferences: Electron.WebPreferences }) {
      this.webPreferences = options.webPreferences;
      const contents = Object.assign(new Emitter(), {
        destroyed: false,
        loadURL: vi.fn(() => loadResult.next),
        setWindowOpenHandler: vi.fn(),
        setWebRTCIPHandlingPolicy: vi.fn(),
        isDestroyed: () => contents.destroyed,
        close: vi.fn(() => {
          contents.destroyed = true;
        }),
      }) as MockContents;
      this.webContents = contents;
      created.push(this);
    }
  }
  return { WebContentsView: WebContentsViewMock };
});

const { createPluginTabGuest } = await import("./plugin-tab-guest");

function hooks() {
  return {
    loaded: vi.fn(),
    loadFailed: vi.fn(),
    crashed: vi.fn(),
    keyDown: vi.fn((input: { key: string }) => input.key === "k"),
  };
}

function spawn(hookSet = hooks()) {
  const prepareSession = vi.fn(() => ({}) as Session);
  const guest = createPluginTabGuest(
    { pluginId: "graph", background: "#101010", hooks: hookSet },
    { preloadPath: "/out/preload/plugin-tab.js", prepareSession },
  );
  const view = created.at(-1);
  if (!view) throw new Error("view not created");
  return { guest, view, contents: view.webContents, hooks: hookSet, prepareSession };
}

function navigation(url: string) {
  return { url, preventDefault: vi.fn() };
}

function keyDown(key: string, modifiers: { meta?: boolean; control?: boolean; shift?: boolean }) {
  return { type: "keyDown", key, code: `Key${key.toUpperCase()}`, alt: false, ...modifiers };
}

beforeEach(() => {
  created.length = 0;
  loadResult.next = Promise.resolve();
});

describe("createPluginTabGuest", () => {
  it("creates a sandboxed, isolated view on the plugin's partition and loads its entry", () => {
    const { view, contents, prepareSession } = spawn();
    expect(prepareSession).toHaveBeenCalledWith("graph");
    expect(view.webPreferences).toMatchObject({
      partition: "persist:cadencr-tab:graph",
      preload: "/out/preload/plugin-tab.js",
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
    });
    expect(view.setBackgroundColor).toHaveBeenCalledWith("#101010");
    expect(contents.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith("disable_non_proxied_udp");
    expect(contents.loadURL).toHaveBeenCalledWith("cadencr-tab://graph/");
  });

  it("denies popups and every navigation off its own origin", () => {
    const { contents } = spawn();
    const openHandler = contents.setWindowOpenHandler.mock.calls[0]?.[0] as () => unknown;
    expect(openHandler()).toEqual({ action: "deny" });

    for (const event of ["will-navigate", "will-frame-navigate", "will-redirect"]) {
      const foreign = navigation("https://example.com/");
      contents.emit(event, foreign);
      expect(foreign.preventDefault).toHaveBeenCalled();
      const other = navigation("cadencr-tab://other/");
      contents.emit(event, other);
      expect(other.preventDefault).toHaveBeenCalled();
      const own = navigation("cadencr-tab://graph/settings.html");
      contents.emit(event, own);
      expect(own.preventDefault).not.toHaveBeenCalled();
    }
  });

  it("signals loaded after a successful load", () => {
    const { contents, hooks: h } = spawn();
    contents.emit("did-start-loading");
    contents.emit("did-navigate", {}, "cadencr-tab://graph/", 200, "OK");
    contents.emit("did-finish-load");
    expect(h.loaded).toHaveBeenCalledTimes(1);
    expect(h.loadFailed).not.toHaveBeenCalled();
  });

  it("turns an HTTP error entry into one failure and no loaded signal", () => {
    const { contents, hooks: h } = spawn();
    contents.emit("did-start-loading");
    contents.emit("did-navigate", {}, "cadencr-tab://graph/", 404, "Not Found");
    contents.emit("did-finish-load");
    expect(h.loadFailed).toHaveBeenCalledWith("HTTP 404 Not Found");
    expect(h.loaded).not.toHaveBeenCalled();
  });

  it("reports main-frame load failures once, ignoring aborted loads", async () => {
    const failure = Object.assign(new Error("ERR_FAILED (-2) loading 'cadencr-tab://graph/'"), {
      errno: -2,
    });
    loadResult.next = Promise.reject(failure);
    const { contents, hooks: h } = spawn();
    contents.emit("did-fail-load", {}, -3, "ERR_ABORTED", "cadencr-tab://graph/", true);
    contents.emit("did-fail-load", {}, -2, "ERR_FAILED", "cadencr-tab://graph/x.png", false);
    expect(h.loadFailed).not.toHaveBeenCalled();
    contents.emit("did-fail-load", {}, -2, "ERR_FAILED", "cadencr-tab://graph/", true);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.loadFailed).toHaveBeenCalledTimes(1);
    expect(h.loadFailed).toHaveBeenCalledWith("ERR_FAILED (-2)");
  });

  it("does not report a superseded first load", async () => {
    loadResult.next = Promise.reject(Object.assign(new Error("ERR_ABORTED (-3)"), { errno: -3 }));
    const { hooks: h } = spawn();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.loadFailed).not.toHaveBeenCalled();
  });

  it("reports a crash, but not after the host destroyed the guest", () => {
    const first = spawn();
    first.contents.emit("render-process-gone", {}, { reason: "oom", exitCode: 1 });
    expect(first.hooks.crashed).toHaveBeenCalledWith("oom");

    const second = spawn();
    second.guest.destroy();
    expect(second.contents.close).toHaveBeenCalledTimes(1);
    second.contents.emit("render-process-gone", {}, { reason: "clean-exit", exitCode: 0 });
    second.contents.emit("did-finish-load");
    expect(second.hooks.crashed).not.toHaveBeenCalled();
    expect(second.hooks.loaded).not.toHaveBeenCalled();
    second.guest.destroy();
    expect(second.contents.close).toHaveBeenCalledTimes(1);
  });

  it("hands every key down to the host and takes only the ones it claims", () => {
    const { contents, hooks: h } = spawn();
    const claimed = { preventDefault: vi.fn() };
    contents.emit("before-input-event", claimed, keyDown("k", { meta: true, shift: true }));
    expect(claimed.preventDefault).toHaveBeenCalled();
    expect(h.keyDown).toHaveBeenCalledWith({
      key: "k",
      code: "KeyK",
      meta: true,
      control: undefined,
      alt: false,
      shift: true,
    });

    const typed = { preventDefault: vi.fn() };
    contents.emit("before-input-event", typed, keyDown("a", {}));
    const released = { preventDefault: vi.fn() };
    contents.emit("before-input-event", released, { ...keyDown("k", {}), type: "keyUp" });
    expect(typed.preventDefault).not.toHaveBeenCalled();
    expect(released.preventDefault).not.toHaveBeenCalled();
    expect(h.keyDown).toHaveBeenCalledTimes(2);
  });
});
