import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";

const electronState = vi.hoisted(() => ({
  isPackaged: true,
  handlers: new Map<string, (event: IpcMainInvokeEvent) => Promise<void> | void>(),
}));

const updaterState = vi.hoisted(() => ({
  quitAndInstall: vi.fn(),
  checkForUpdates: vi.fn(() => Promise.resolve()),
  on: vi.fn(),
}));

vi.mock("./linux-install-type", () => ({
  detectLinuxInstallType: vi.fn(() => "deb"),
}));

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return electronState.isPackaged;
    },
    getVersion: () => "0.1.0",
  },
  ipcMain: {
    handle: vi.fn(
      (channel: string, handler: (event: IpcMainInvokeEvent) => Promise<void> | void) => {
        electronState.handlers.set(channel, handler);
      },
    ),
  },
}));

vi.mock("electron-updater", () => ({
  default: {
    autoUpdater: {
      get autoDownload() {
        return true;
      },
      set autoDownload(_value: boolean) {},
      get autoInstallOnAppQuit() {
        return true;
      },
      set autoInstallOnAppQuit(_value: boolean) {},
      get logger() {
        return console;
      },
      set logger(_value: Console) {},
      checkForUpdates: updaterState.checkForUpdates,
      quitAndInstall: updaterState.quitAndInstall,
      on: updaterState.on,
    },
  },
}));

import { registerAutoUpdaterIpc } from "./updater";

function trustedEvent(): IpcMainInvokeEvent {
  return {
    sender: { id: 7 },
    senderFrame: { url: "file:///app/index.html" },
  } as unknown as IpcMainInvokeEvent;
}

function mainWindow(): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: { id: 7, isDestroyed: () => false, send: vi.fn() },
  } as unknown as BrowserWindow;
}

describe("auto-updater IPC", () => {
  beforeEach(() => {
    electronState.isPackaged = true;
    electronState.handlers.clear();
    updaterState.quitAndInstall.mockClear();
    updaterState.checkForUpdates.mockClear();
    updaterState.on.mockClear();
  });

  it("runs install preparation before quitAndInstall for a Linux deb package", async () => {
    const calls: string[] = [];

    registerAutoUpdaterIpc({
      getMainWindow: () => mainWindow(),
      prepareInstallUpdate: async () => {
        calls.push("prepare");
      },
    });

    updaterState.quitAndInstall.mockImplementation(() => calls.push("quitAndInstall"));

    const handler = electronState.handlers.get("app:install-update");
    expect(handler).toBeDefined();
    await handler?.(trustedEvent());

    const checkHandler = electronState.handlers.get("app:check-for-updates");
    expect(checkHandler).toBeDefined();
    await checkHandler?.(trustedEvent());

    expect(calls).toEqual(["prepare", "quitAndInstall"]);
    expect(updaterState.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(updaterState.checkForUpdates).toHaveBeenCalledOnce();
  });
});
