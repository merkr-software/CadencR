import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, IpcMainEvent } from "electron";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  listeners: new Map<string, Handler>(),
}));

vi.mock("../renderer-window-security", () => ({
  rendererLoadTarget: () => ({ kind: "url", value: "http://127.0.0.1:1420/" }),
}));

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: vi.fn(() => "/tmp"), getVersion: vi.fn(() => "0.0.0") },
  clipboard: { readText: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
  nativeTheme: { shouldUseDarkColors: true, on: vi.fn() },
  session: { fromPartition: vi.fn() },
  MessageChannelMain: class {},
  WebContentsView: class {},
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => ipc.handlers.set(channel, handler)),
    on: vi.fn((channel: string, handler: Handler) => ipc.listeners.set(channel, handler)),
  },
}));

const { answerGuestThemeCss, registerPluginTabIpc } = await import("./plugin-tab-ipc");

const mainWindow = {
  webContents: { id: 7, mainFrame: { url: "http://127.0.0.1:1420/", processId: 1, routingId: 2 } },
} as unknown as BrowserWindow;
const trusted = {
  sender: { id: 7 },
  senderFrame: { url: "http://127.0.0.1:1420/", processId: 1, routingId: 2 },
};
const untrusted = { sender: { id: 99 }, senderFrame: { url: "cadencr-tab://graph/" } };

function invoke(channel: string, event: unknown, ...args: unknown[]): unknown {
  const handler = ipc.handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return handler(event, ...args);
}

describe("registerPluginTabIpc", () => {
  beforeEach(() => {
    ipc.handlers.clear();
    ipc.listeners.clear();
  });

  it("registers every renderer channel and the guest theme query", () => {
    registerPluginTabIpc({ getMainWindow: () => mainWindow, preloadPath: "/p.js" });
    expect([...ipc.handlers.keys()].sort()).toEqual([
      "plugin-tab:close",
      "plugin-tab:open",
      "plugin-tab:open-devtools",
      "plugin-tab:reload",
      "plugin-tab:set-app-shortcuts",
      "plugin-tab:set-bounds",
      "plugin-tab:set-tab-shortcuts",
      "plugin-tab:set-theme",
      "plugin-tab:set-visible",
    ]);
    expect([...ipc.listeners.keys()]).toEqual(["cadencr-tab:theme-css"]);
  });

  it("rejects calls from anything but the main window", () => {
    registerPluginTabIpc({ getMainWindow: () => mainWindow, preloadPath: "/p.js" });
    expect(() => invoke("plugin-tab:close", untrusted, "i1")).toThrow("untrusted window");
  });

  it("validates ids, bounds and theme at the boundary", () => {
    registerPluginTabIpc({ getMainWindow: () => mainWindow, preloadPath: "/p.js" });
    expect(() => invoke("plugin-tab:open", trusted, "i1", "../evil")).toThrow(
      "Expected a custom tab id.",
    );
    expect(() => invoke("plugin-tab:close", trusted, "bad id")).toThrow(
      "Expected a custom tab instance id.",
    );
    expect(() => invoke("plugin-tab:set-bounds", trusted, "i1", { x: 1 })).toThrow();
    expect(() => invoke("plugin-tab:set-visible", trusted, "i1", "yes")).toThrow();
    expect(() =>
      invoke("plugin-tab:set-theme", trusted, { css: "", background: "url(x)" }),
    ).toThrow();
    expect(() =>
      invoke("plugin-tab:set-theme", trusted, { css: "", background: "#0f1115", extra: 1 }),
    ).toThrow();
    expect(() =>
      invoke("plugin-tab:set-theme", trusted, { css: ":root{}", background: "rgb(1, 2, 3)" }),
    ).not.toThrow();
    // Layout calls for an instance that is not open are a benign race.
    expect(() => invoke("plugin-tab:set-visible", trusted, "i1", true)).not.toThrow();
  });
});

describe("answerGuestThemeCss", () => {
  it("answers known guests with the theme and everyone else with nothing", () => {
    const manager = {
      isGuestWebContents: (id: number) => id === 42,
      themeCss: () => ":root{--cadencr-background:#000}",
    };
    const guestEvent = { sender: { id: 42 }, returnValue: undefined } as unknown as IpcMainEvent;
    answerGuestThemeCss(manager, guestEvent);
    expect(guestEvent.returnValue).toBe(":root{--cadencr-background:#000}");

    const otherEvent = { sender: { id: 7 }, returnValue: undefined } as unknown as IpcMainEvent;
    answerGuestThemeCss(manager, otherEvent);
    expect(otherEvent.returnValue).toBe("");
  });
});
