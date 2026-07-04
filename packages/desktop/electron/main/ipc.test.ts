import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clipboard,
  ipcMain,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";

const electronState = vi.hoisted(() => ({
  isPackaged: false,
  logsPath: "",
  readClipboardText: vi.fn(() => "terminal paste"),
  openExternal: vi.fn<(_url: string) => Promise<void>>(() => Promise.resolve()),
}));

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return electronState.isPackaged;
    },
    getPath: vi.fn(() => electronState.logsPath),
    getVersion: vi.fn(() => "0.6.1"),
  },
  dialog: { showOpenDialog: vi.fn() },
  clipboard: { readText: electronState.readClipboardText },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  nativeTheme: { shouldUseDarkColors: false, on: vi.fn() },
  shell: { openExternal: electronState.openExternal, showItemInFolder: vi.fn() },
}));

import {
  assertTrustedSender,
  canonicalFilePath,
  clearRegisteredFilePaths,
  openExternal,
  parseNotifyOptions,
  parseZoomFactor,
  readFileBase64,
  registerIpc,
  registerFilePaths,
} from "./ipc";

function trustedEvent(
  senderFrameUrl: string | null = "http://127.0.0.1:1420/",
): IpcMainInvokeEvent {
  return {
    sender: { id: 7 },
    senderFrame: senderFrameUrl === null ? null : { url: senderFrameUrl },
  } as unknown as IpcMainInvokeEvent;
}

function ipcEvent(senderId: number, senderFrameUrl: string | null): IpcMainInvokeEvent {
  return {
    sender: { id: senderId },
    senderFrame: senderFrameUrl === null ? null : { url: senderFrameUrl },
  } as unknown as IpcMainInvokeEvent;
}

function mainWindow(): BrowserWindow {
  return { webContents: { id: 7 } } as unknown as BrowserWindow;
}

function ipcHandler(channel: string): (event: IpcMainInvokeEvent, payload?: unknown) => unknown {
  const handlerCall = vi.mocked(ipcMain.handle).mock.calls.find(([registeredChannel]) => {
    return registeredChannel === channel;
  });
  expect(handlerCall).toBeDefined();
  return handlerCall?.[1] as (event: IpcMainInvokeEvent, payload?: unknown) => unknown;
}

describe("ipc validators", () => {
  beforeEach(() => {
    electronState.isPackaged = false;
    electronState.logsPath = "";
    electronState.readClipboardText.mockClear();
    electronState.openExternal.mockClear();
    vi.mocked(ipcMain.handle).mockClear();
    vi.mocked(ipcMain.on).mockClear();
    clearRegisteredFilePaths();
  });

  it("bounds zoom factors", () => {
    expect(parseZoomFactor(1.25)).toBe(1.25);
    expect(() => parseZoomFactor(0.49)).toThrow(/between 0.5 and 2/);
    expect(() => parseZoomFactor(Number.NaN)).toThrow(/numeric/);
  });

  it("validates notification options", () => {
    expect(
      parseNotifyOptions({
        title: "Done",
        body: "Agent complete",
        featureId: 1,
        projectId: 2,
        routeType: "session",
        mode: "native",
      }),
    ).toEqual({
      title: "Done",
      body: "Agent complete",
      featureId: 1,
      projectId: 2,
      routeType: "session",
      mode: "native",
    });
    expect(() => parseNotifyOptions({ routeType: "bad" })).toThrow(/route type/);
    expect(() =>
      parseNotifyOptions({
        title: "Done",
        body: "Agent complete",
        featureId: 1,
        projectId: 2,
        routeType: "session",
        mode: "bogus",
      }),
    ).toThrow(/notification mode/);
  });

  it("canonicalizes files and rejects traversal and directories", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cadencr-ipc-"));
    const file = path.join(dir, "image.png");
    await fs.writeFile(file, "hello", "utf8");

    await expect(canonicalFilePath(file)).resolves.toBe(await fs.realpath(file));
    await expect(canonicalFilePath(`${dir}/../${path.basename(dir)}/image.png`)).rejects.toThrow(
      /contains `\.\.`/,
    );
    await expect(canonicalFilePath(dir)).rejects.toThrow(/not a file/);
  });

  it("uses dropped-file handles once", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cadencr-handle-"));
    const file = path.join(dir, "image.png");
    await fs.writeFile(file, "hello", "utf8");

    const [registered] = await registerFilePaths([file]);

    await expect(readFileBase64(registered.handle)).resolves.toBe(
      Buffer.from("hello").toString("base64"),
    );
    await expect(readFileBase64(registered.handle)).rejects.toThrow(/expired/);
  });

  it("opens only approved external urls", async () => {
    await openExternal("https://example.com/path");
    await expect(openExternal("http://example.com")).rejects.toThrow(/https/);
    await expect(openExternal("https://user@example.com")).rejects.toThrow(/credentials/);
    await expect(openExternal("https://127.0.0.1:5004")).rejects.toThrow(/Loopback/);
    expect(electronState.openExternal).toHaveBeenCalledTimes(1);
  });

  it("accepts null senderFrame only after the sender webContents matched", () => {
    expect(() => assertTrustedSender(trustedEvent(null), () => mainWindow())).not.toThrow();
    expect(() => assertTrustedSender(ipcEvent(8, null), () => mainWindow())).toThrow(
      /untrusted window/,
    );
    expect(() =>
      assertTrustedSender(trustedEvent("https://evil.example"), () => mainWindow()),
    ).toThrow(/untrusted renderer/);
  });

  it("registers trusted renderer error reports to the app log directory", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cadencr-renderer-error-ipc-"));
    electronState.logsPath = dir;

    registerIpc({
      getMainWindow: () => mainWindow(),
      confirmClose: vi.fn(),
      requestQuit: vi.fn(),
    });

    ipcHandler("app:renderer-error")(trustedEvent(), {
      source: "error",
      message: "global crash",
      stack: "Error: global crash",
    });

    const log = await fs.readFile(path.join(dir, "renderer-errors.log"), "utf8");
    expect(log).toContain("message: global crash");
  });

  it("does not expose privileged clipboard reads to renderers", () => {
    registerIpc({
      getMainWindow: () => mainWindow(),
      confirmClose: vi.fn(),
      requestQuit: vi.fn(),
    });

    const handlerCall = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => {
      return channel === "clipboard:read-text";
    });
    expect(handlerCall).toBeUndefined();
    expect(clipboard.readText).not.toHaveBeenCalled();
  });

  it("registers trusted native context-menu suppression for renderer-owned menus", () => {
    registerIpc({
      getMainWindow: () => mainWindow(),
      confirmClose: vi.fn(),
      requestQuit: vi.fn(),
    });

    const handlerCall = vi.mocked(ipcMain.on).mock.calls.find(([channel]) => {
      return channel === "context-menu:suppress-next";
    });
    expect(handlerCall).toBeDefined();
    const handler = handlerCall?.[1] as (event: IpcMainEvent) => void;
    const event = { ...trustedEvent(), returnValue: false } as unknown as IpcMainEvent;

    handler(event);

    expect(event.returnValue).toBe(true);
  });

  it("registers native window control handlers", () => {
    const minimize = vi.fn();
    const maximize = vi.fn();
    const unmaximize = vi.fn();
    const close = vi.fn();
    const win = {
      webContents: { id: 7 },
      minimize,
      maximize,
      unmaximize,
      close,
      isMaximized: vi.fn(() => false),
    } as unknown as BrowserWindow;

    registerIpc({
      getMainWindow: () => win,
      confirmClose: vi.fn(),
      requestQuit: vi.fn(),
    });

    ipcHandler("app:window-minimize")(trustedEvent());
    ipcHandler("app:window-toggle-maximize")(trustedEvent());
    ipcHandler("app:window-close")(trustedEvent());

    expect(minimize).toHaveBeenCalledTimes(1);
    expect(maximize).toHaveBeenCalledTimes(1);
    expect(unmaximize).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
