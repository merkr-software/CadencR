import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, MessagePortMain } from "electron";

vi.mock("electron", () => ({ MessageChannelMain: class {} }));

const { PluginTabManager } = await import("./plugin-tab-manager");
const { PluginTabPorts } = await import("./plugin-tab-ports");
type PluginTabGuest = import("./plugin-tab-guest").PluginTabGuest;
type PluginTabGuestOptions = import("./plugin-tab-guest").PluginTabGuestOptions;
type PluginTabKeyInput = import("../../../src/shared/plugin-tab-host").PluginTabKeyInput;

interface FakeGuest {
  options: PluginTabGuestOptions;
  focused: boolean;
  destroyed: boolean;
  view: {
    setVisible: ReturnType<typeof vi.fn>;
    setBounds: ReturnType<typeof vi.fn>;
    setBackgroundColor: ReturnType<typeof vi.fn>;
  };
  webContents: {
    id: number;
    isDestroyed: () => boolean;
    isFocused: () => boolean;
    focus: ReturnType<typeof vi.fn>;
    reload: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
    openDevTools: ReturnType<typeof vi.fn>;
  };
  destroy: ReturnType<typeof vi.fn>;
}

let guests: FakeGuest[] = [];
let nextId = 100;
let channels: Array<{
  port1: { close: ReturnType<typeof vi.fn> };
  port2: { close: ReturnType<typeof vi.fn> };
}>;

function createGuest(options: PluginTabGuestOptions): PluginTabGuest {
  const guest: FakeGuest = {
    options,
    focused: false,
    destroyed: false,
    view: { setVisible: vi.fn(), setBounds: vi.fn(), setBackgroundColor: vi.fn() },
    webContents: {
      id: nextId++,
      isDestroyed: () => guest.destroyed,
      isFocused: () => guest.focused,
      focus: vi.fn(),
      reload: vi.fn(),
      send: vi.fn(),
      postMessage: vi.fn(),
      openDevTools: vi.fn(),
    },
    destroy: vi.fn(() => {
      guest.destroyed = true;
    }),
  };
  guests.push(guest);
  return guest as unknown as PluginTabGuest;
}

function fakeWindow() {
  const listeners = new Map<string, Set<() => void>>();
  const win = {
    isDestroyed: () => false,
    on: vi.fn((event: string, callback: () => void) => {
      const handlers = listeners.get(event) ?? new Set();
      handlers.add(callback);
      listeners.set(event, handlers);
    }),
    removeListener: vi.fn((event: string, callback: () => void) =>
      listeners.get(event)?.delete(callback),
    ),
    emitNative: (event: string) => {
      for (const callback of listeners.get(event) ?? []) callback();
    },
    getBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
    getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    webContents: {
      id: 1,
      isDestroyed: () => false,
      getZoomFactor: () => 1,
      focus: vi.fn(),
      send: vi.fn(),
      postMessage: vi.fn(),
    },
  };
  return win;
}

let win: ReturnType<typeof fakeWindow>;

function manager(maxLive = 6) {
  const ports = new PluginTabPorts(() => {
    const pair = { port1: { close: vi.fn() }, port2: { close: vi.fn() } };
    channels.push(pair);
    return pair as unknown as { port1: MessagePortMain; port2: MessagePortMain };
  });
  return new PluginTabManager({
    getMainWindow: () => win as unknown as BrowserWindow,
    createGuest,
    defaultBackground: () => "#000000",
    ports,
    maxLive,
  });
}

function events(): unknown[] {
  return win.webContents.send.mock.calls
    .filter(([channel]) => channel === "plugin-tab:event")
    .map(([, event]) => event);
}

const BOUNDS = { x: 10, y: 20, width: 300, height: 200 };

beforeEach(() => {
  guests = [];
  channels = [];
  win = fakeWindow();
});

describe("PluginTabManager layout", () => {
  it("creates the guest on open and attaches it only once it has bounds", () => {
    const tabs = manager();
    tabs.open("i1", "graph");
    expect(guests).toHaveLength(1);
    expect(guests[0]?.options.pluginId).toBe("graph");
    expect(guests[0]?.options.background).toBe("#000000");
    expect(win.contentView.addChildView).not.toHaveBeenCalled();

    tabs.setVisible("i1", true);
    tabs.setBounds("i1", BOUNDS, 2);

    expect(win.contentView.addChildView).toHaveBeenCalledWith(guests[0]?.view);
    expect(guests[0]?.view.setVisible).toHaveBeenLastCalledWith(true);
    expect(guests[0]?.view.setBounds).toHaveBeenLastCalledWith({
      x: 20,
      y: 40,
      width: 600,
      height: 400,
    });
  });

  it("fully detaches a hidden guest and re-attaches it when shown", () => {
    const tabs = manager();
    tabs.open("i1", "graph");
    tabs.setVisible("i1", true);
    tabs.setBounds("i1", BOUNDS, 1);
    tabs.setVisible("i1", false);
    expect(win.contentView.removeChildView).toHaveBeenCalledWith(guests[0]?.view);
    tabs.setVisible("i1", true);
    expect(win.contentView.addChildView).toHaveBeenCalledTimes(2);
    expect(guests[0]?.view.setVisible).toHaveBeenLastCalledWith(true);
  });

  it("keeps hidden guests out of the window when an overlay closes", () => {
    const tabs = manager();
    tabs.open("a", "graph");
    tabs.setBounds("a", BOUNDS, 1);
    tabs.setSuppressed(true);
    tabs.setSuppressed(false);
    expect(win.contentView.addChildView).not.toHaveBeenCalled();
  });

  it("detaches every guest while suppressed and hands focus back to the renderer", () => {
    const tabs = manager();
    tabs.open("i1", "graph");
    tabs.setVisible("i1", true);
    tabs.setBounds("i1", BOUNDS, 1);
    const guest = guests[0];
    if (!guest) throw new Error("guest missing");
    guest.focused = true;

    tabs.setSuppressed(true);
    expect(win.contentView.removeChildView).toHaveBeenCalledWith(guest.view);
    expect(win.webContents.focus).toHaveBeenCalled();

    tabs.setSuppressed(false);
    expect(win.contentView.addChildView).toHaveBeenCalledTimes(2);
  });

  it("detaches a guest whose placeholder collapsed to zero size", () => {
    const tabs = manager();
    tabs.open("i1", "graph");
    tabs.setVisible("i1", true);
    tabs.setBounds("i1", BOUNDS, 1);
    tabs.setBounds("i1", { x: 0, y: 0, width: 0, height: 0 }, 1);
    expect(win.contentView.removeChildView).toHaveBeenCalledWith(guests[0]?.view);
  });

  it("reclaims OS focus when a focused guest is hidden", () => {
    const tabs = manager();
    tabs.open("i1", "graph");
    tabs.setVisible("i1", true);
    if (guests[0]) guests[0].focused = true;
    tabs.setVisible("i1", false);
    expect(win.webContents.focus).toHaveBeenCalledTimes(1);
  });

  it("ignores layout calls for unknown instances", () => {
    const tabs = manager();
    expect(() => tabs.setBounds("gone", BOUNDS, 1)).not.toThrow();
    expect(() => tabs.setVisible("gone", true)).not.toThrow();
    expect(() => tabs.reload("gone")).toThrow("Unknown custom tab instance");
  });
});

describe("PluginTabManager live-guest cap", () => {
  it("recycles the least recently shown hidden guest and recreates it on demand", () => {
    const tabs = manager(2);
    tabs.open("a", "graph");
    tabs.setVisible("a", true);
    tabs.setVisible("a", false);
    tabs.open("b", "graph");
    tabs.setVisible("b", true);
    tabs.setVisible("b", false);
    tabs.open("c", "graph");

    expect(guests[0]?.destroy).toHaveBeenCalled();
    expect(events()).toContainEqual({ instanceId: "a", type: "recycled" });

    tabs.setVisible("a", true);
    expect(guests).toHaveLength(4);
    expect(guests[3]?.options.pluginId).toBe("graph");
    expect(guests[1]?.destroy).toHaveBeenCalled();
    expect(events()).toContainEqual({ instanceId: "b", type: "recycled" });
  });

  it("never recycles visible guests", () => {
    const tabs = manager(1);
    tabs.open("a", "graph");
    tabs.setVisible("a", true);
    tabs.open("b", "graph");
    tabs.setVisible("b", true);
    expect(guests.every((guest) => !guest.destroyed)).toBe(true);
  });
});

describe("PluginTabManager lifecycle", () => {
  it("bootstraps a fresh port pair on every load and closes the previous one", () => {
    const tabs = manager();
    tabs.open("i1", "graph");
    const guest = guests[0];
    guest?.options.hooks.loaded();

    expect(guest?.webContents.postMessage).toHaveBeenCalledWith("cadencr-tab:port", null, [
      channels[0]?.port1,
    ]);
    expect(win.webContents.postMessage).toHaveBeenCalledWith(
      "plugin-tab:port",
      { instanceId: "i1" },
      [channels[0]?.port2],
    );
    expect(events()).toContainEqual({ instanceId: "i1", type: "loaded" });

    guest?.options.hooks.loaded();
    expect(channels).toHaveLength(2);
    expect(channels[0]?.port1.close).toHaveBeenCalled();
    expect(channels[0]?.port2.close).toHaveBeenCalled();
  });

  it("reports load failures", () => {
    const tabs = manager();
    tabs.open("i1", "graph");
    guests[0]?.options.hooks.loadFailed("HTTP 404 Not Found");
    expect(events()).toContainEqual({
      instanceId: "i1",
      type: "load-failed",
      detail: "HTTP 404 Not Found",
    });
  });

  it("destroys a crashed guest and recreates it only on reload", () => {
    const tabs = manager();
    tabs.open("i1", "graph");
    guests[0]?.options.hooks.crashed("crashed");

    expect(guests[0]?.destroy).toHaveBeenCalled();
    expect(events()).toContainEqual({ instanceId: "i1", type: "crashed", detail: "crashed" });
    tabs.setVisible("i1", true);
    expect(guests).toHaveLength(1);
    tabs.open("i1", "graph");
    expect(guests).toHaveLength(1);
    expect(events().filter((event) => (event as { type: string }).type === "crashed")).toHaveLength(
      2,
    );

    tabs.reload("i1");
    expect(guests).toHaveLength(2);
  });

  it("reloads a live guest in place", () => {
    const tabs = manager();
    tabs.open("i1", "graph");
    tabs.reload("i1");
    expect(guests[0]?.webContents.reload).toHaveBeenCalled();
    expect(guests).toHaveLength(1);
  });

  it("ignores events from a guest that was already closed", () => {
    const tabs = manager();
    tabs.open("i1", "graph");
    const guest = guests[0];
    tabs.close("i1");
    guest?.options.hooks.loaded();
    guest?.options.hooks.crashed("killed");
    expect(guest?.destroy).toHaveBeenCalledTimes(1);
    expect(channels).toHaveLength(0);
    expect(events()).toEqual([]);
  });

  it("replaces the guest when an instance is reopened for another plugin", () => {
    const tabs = manager();
    tabs.open("i1", "graph");
    tabs.open("i1", "other");
    expect(guests[0]?.destroy).toHaveBeenCalled();
    expect(guests[1]?.options.pluginId).toBe("other");
    tabs.open("i1", "other");
    expect(guests).toHaveLength(2);
  });

  it("opens DevTools detached and focuses only a visible attached guest", () => {
    const tabs = manager();
    tabs.open("i1", "graph");
    tabs.openDevTools("i1");
    expect(guests[0]?.webContents.openDevTools).toHaveBeenCalledWith({ mode: "detach" });
    tabs.focus("i1");
    expect(guests[0]?.webContents.focus).not.toHaveBeenCalled();
    tabs.setVisible("i1", true);
    tabs.setBounds("i1", BOUNDS, 1);
    tabs.focus("i1");
    expect(guests[0]?.webContents.focus).toHaveBeenCalled();
  });

  it("hands Cadencr's shortcuts to the renderer, the tab's own to its page, and the rest back", () => {
    const tabs = manager();
    tabs.setAppShortcuts([{ keys: ["mod", "k"] }]);
    tabs.setTabShortcuts("i1", [{ id: "refresh", keys: ["mod", "shift", "r"] }]);
    tabs.open("i1", "graph");
    const hooks = guests[0]?.options.hooks;
    const mod = process.platform === "darwin" ? { meta: true } : { control: true };
    const key = (letter: string, extra: Partial<PluginTabKeyInput> = {}): PluginTabKeyInput => ({
      key: letter,
      code: `Key${letter.toUpperCase()}`,
      meta: false,
      control: false,
      alt: false,
      shift: false,
      ...mod,
      ...extra,
    });

    expect(hooks?.keyDown(key("k"))).toBe(true);
    expect(win.webContents.focus).toHaveBeenCalled();
    expect(win.webContents.send).toHaveBeenCalledWith("plugin-tab:app-shortcut", key("k"));

    expect(hooks?.keyDown(key("r", { shift: true }))).toBe(true);
    expect(win.webContents.send).toHaveBeenCalledWith("plugin-tab:event", {
      instanceId: "i1",
      type: "shortcut",
      detail: "refresh",
    });

    vi.mocked(win.webContents.send).mockClear();
    expect(hooks?.keyDown(key("r"))).toBe(false);
    expect(hooks?.keyDown({ ...key("k"), meta: false, control: false })).toBe(false);
    expect(win.webContents.send).not.toHaveBeenCalled();

    // Closing the instance drops its shortcuts; Cadencr's stay.
    tabs.close("i1");
    tabs.open("i1", "graph");
    const reopened = guests[1]?.options.hooks;
    expect(reopened?.keyDown(key("r", { shift: true }))).toBe(false);
    expect(reopened?.keyDown(key("k"))).toBe(true);
  });

  it("destroys and detaches everything when the window goes away", () => {
    const tabs = manager();
    tabs.open("a", "graph");
    tabs.setVisible("a", true);
    tabs.setBounds("a", BOUNDS, 1);
    tabs.open("b", "graph");
    tabs.destroyAll();
    expect(guests.every((guest) => guest.destroyed)).toBe(true);
    expect(win.contentView.removeChildView).toHaveBeenCalledWith(guests[0]?.view);
    expect(() => tabs.reload("a")).toThrow();
  });
});

describe("PluginTabManager theme", () => {
  it("pushes the theme to live guests and only answers known guests", () => {
    const tabs = manager();
    tabs.open("i1", "graph");
    tabs.setTheme({ css: ":root{--cadencr-background:#111}", background: "#111111" });

    expect(guests[0]?.view.setBackgroundColor).toHaveBeenCalledWith("#111111");
    expect(guests[0]?.webContents.send).toHaveBeenCalledWith(
      "cadencr-tab:theme",
      ":root{--cadencr-background:#111}",
    );
    expect(tabs.themeCss()).toBe(":root{--cadencr-background:#111}");
    expect(tabs.isGuestWebContents(guests[0]?.webContents.id ?? -1)).toBe(true);
    expect(tabs.isGuestWebContents(win.webContents.id)).toBe(false);

    guests[0]?.webContents.send.mockClear();
    tabs.setTheme({ css: ":root{--cadencr-background:#111}", background: "#111111" });
    expect(guests[0]?.webContents.send).not.toHaveBeenCalled();

    tabs.open("i2", "graph");
    expect(guests[1]?.options.background).toBe("#111111");
  });
});

describe("PluginTabPorts", () => {
  it("sends nothing when the main window is gone", () => {
    const createChannel = vi.fn();
    const ports = new PluginTabPorts(createChannel);
    const guest = { isDestroyed: () => false, postMessage: vi.fn() };
    ports.bootstrap("i1", guest, null);
    expect(createChannel).not.toHaveBeenCalled();
    expect(guest.postMessage).not.toHaveBeenCalled();
  });
});

describe("shared plugin surfaces", () => {
  it("keeps tab and editor instances separate and refuses reusing an identity", () => {
    const host = manager();
    host.open("7:plugin:graph", "graph", { kind: "tab" });
    host.open("7:editor:graph", "graph", { kind: "editor" });
    expect(guests).toHaveLength(2);
    expect(() => host.open("7:plugin:graph", "graph", { kind: "editor" })).toThrow(/surface/i);
    host.close("7:editor:graph");
    expect(guests[0]?.destroyed).toBe(false);
    expect(guests[1]?.destroyed).toBe(true);
  });

  it("reports focus changes and clears focus when a surface is hidden", () => {
    const host = manager();
    host.open("7:editor:graph", "graph", { kind: "editor" });
    host.setBounds("7:editor:graph", BOUNDS);
    host.setVisible("7:editor:graph", true);
    guests[0]?.options.hooks.focusChanged?.(true);
    host.setVisible("7:editor:graph", false);
    expect(events()).toContainEqual({ instanceId: "7:editor:graph", type: "focused" });
    expect(events()).toContainEqual({ instanceId: "7:editor:graph", type: "blurred" });
  });
});

it("updates focus across native windows and releases window listeners on teardown", () => {
  const host = manager();
  host.open("7:editor:graph", "graph", { kind: "editor" });
  host.setBounds("7:editor:graph", BOUNDS);
  host.setVisible("7:editor:graph", true);
  if (guests[0]) guests[0].focused = true;
  host.focus("7:editor:graph");
  expect(events().at(-1)).toEqual({ instanceId: "7:editor:graph", type: "focused" });
  win.emitNative("blur");
  expect(events().at(-1)).toEqual({ instanceId: "7:editor:graph", type: "blurred" });
  win.emitNative("focus");
  expect(events().at(-1)).toEqual({ instanceId: "7:editor:graph", type: "focused" });
  host.destroyAll();
  expect(win.removeListener).toHaveBeenCalledTimes(2);
  const count = events().length;
  win.emitNative("focus");
  expect(events()).toHaveLength(count);
});
