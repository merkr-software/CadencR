import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";

const electronState = vi.hoisted(() => ({
  isPackaged: true,
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>(),
}));

const imageState = vi.hoisted(() => ({ fetchChangelogImage: vi.fn() }));

vi.mock("./changelog-images", () => ({ fetchChangelogImage: imageState.fetchChangelogImage }));

const updaterState = vi.hoisted(() => ({
  quitAndInstall: vi.fn(),
  checkForUpdates: vi.fn(() => Promise.resolve()),
  on: vi.fn(),
}));

const installType = vi.hoisted(() => ({ value: "deb" }));
vi.mock("./linux-install-type", () => ({
  detectLinuxInstallType: vi.fn(() => installType.value),
}));

vi.mock("./renderer-window-security", () => ({
  rendererLoadTarget: () => ({ kind: "file", value: "/app/index.html" }),
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
      (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
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

function trustedEvent(): IpcMainInvokeEvent {
  return {
    sender: { id: 7 },
    senderFrame: { url: "file:///app/index.html", processId: 1, routingId: 2 },
  } as unknown as IpcMainInvokeEvent;
}

function mainWindow(): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: {
      id: 7,
      mainFrame: { url: "file:///app/index.html", processId: 1, routingId: 2 },
      isDestroyed: () => false,
      send: vi.fn(),
    },
  } as unknown as BrowserWindow;
}

describe("auto-updater IPC", () => {
  beforeEach(() => {
    vi.resetModules();
    electronState.isPackaged = true;
    electronState.handlers.clear();
    updaterState.quitAndInstall.mockClear();
    updaterState.checkForUpdates.mockClear();
    updaterState.on.mockClear();
    imageState.fetchChangelogImage.mockReset();
  });

  it("runs install preparation before quitAndInstall for a Linux deb package", async () => {
    const { registerAutoUpdaterIpc } = await import("./updater");
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

  it("rejects malformed image arguments before fetching", async () => {
    const { registerAutoUpdaterIpc } = await import("./updater");
    registerAutoUpdaterIpc({ getMainWindow: mainWindow });
    const handler = electronState.handlers.get("app:fetch-changelog-image");
    expect(handler).toBeDefined();

    for (const source of [undefined, null, 42, {}, []]) {
      await expect(handler?.(trustedEvent(), source)).rejects.toThrow(
        "Image source must be a string.",
      );
    }
    expect(imageState.fetchChangelogImage).not.toHaveBeenCalled();
  });

  it("fetches a validated image source from a trusted sender", async () => {
    const { registerAutoUpdaterIpc } = await import("./updater");
    registerAutoUpdaterIpc({ getMainWindow: mainWindow });
    const source = "https://raw.githubusercontent.com/merkr-software/cadencr/v0.13.1/docs/shot.png";
    const response = { data: new Uint8Array([137, 80, 78, 71]), mimeType: "image/png" };
    imageState.fetchChangelogImage.mockResolvedValue(response);
    const handler = electronState.handlers.get("app:fetch-changelog-image");
    expect(handler).toBeDefined();

    await expect(handler?.(trustedEvent(), source)).resolves.toEqual(response);
    expect(imageState.fetchChangelogImage).toHaveBeenCalledWith(source);
  });

  it("keeps the update state in the main process for a renderer that mounts later", async () => {
    const { initAutoUpdater, registerAutoUpdaterIpc, shutdownAutoUpdater } =
      await import("./updater");
    const window = mainWindow();
    registerAutoUpdaterIpc({ getMainWindow: () => window });
    initAutoUpdater({ getMainWindow: () => window });
    const listener = (name: string) =>
      updaterState.on.mock.calls.find(([event]) => event === name)?.[1] as (info: {
        version: string;
      }) => void;
    listener("update-downloaded")({ version: "0.2.0" });

    // A reloaded renderer (or a new window) reads the current state on mount.
    const read = electronState.handlers.get("app:update-state");
    expect(read).toBeDefined();
    expect(await read?.(trustedEvent())).toMatchObject({
      status: "downloaded",
      version: "0.2.0",
      progress: 100,
    });
    shutdownAutoUpdater();
  });

  describe("an unofficial Linux install", () => {
    const realPlatform = process.platform;
    afterEach(() => {
      Object.defineProperty(process, "platform", { value: realPlatform });
      installType.value = "deb";
    });

    it("is unsupported from startup, for a check, and without a duplicate publish", async () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      installType.value = "unknown";
      const { initAutoUpdater, registerAutoUpdaterIpc } = await import("./updater");
      const window = mainWindow();
      registerAutoUpdaterIpc({ getMainWindow: () => window });
      initAutoUpdater({ getMainWindow: () => window });

      const read = await electronState.handlers.get("app:update-state")?.(trustedEvent());
      expect(read).toMatchObject({ status: "unsupported", revision: 1 });
      const checked = await electronState.handlers.get("app:check-for-updates")?.(trustedEvent());
      expect(checked).toEqual(read);
      expect(window.webContents.send).toHaveBeenCalledOnce();
      expect(updaterState.checkForUpdates).not.toHaveBeenCalled();
    });
  });

  it("replays dev update events into the main-process state", async () => {
    electronState.isPackaged = false;
    vi.stubEnv(
      "CADENCR_DEV_UPDATE_EVENTS",
      JSON.stringify([
        { kind: "available", version: "9.9.9" },
        { kind: "download-progress", percent: 42, bytesPerSecond: 1 },
      ]),
    );
    try {
      const { initAutoUpdater, registerAutoUpdaterIpc } = await import("./updater");
      const window = mainWindow();
      registerAutoUpdaterIpc({ getMainWindow: () => window });
      initAutoUpdater({ getMainWindow: () => window });
      expect(await electronState.handlers.get("app:update-state")?.(trustedEvent())).toMatchObject({
        status: "downloading",
        version: "9.9.9",
        progress: 42,
      });
      expect(updaterState.on).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("surfaces malformed dev update events instead of ignoring them", async () => {
    electronState.isPackaged = false;
    vi.stubEnv("CADENCR_DEV_UPDATE_EVENTS", '[{"kind":"downloaded"}]');
    try {
      const { initAutoUpdater, registerAutoUpdaterIpc } = await import("./updater");
      registerAutoUpdaterIpc({ getMainWindow: mainWindow });
      initAutoUpdater({ getMainWindow: mainWindow });
      expect(await electronState.handlers.get("app:update-state")?.(trustedEvent())).toMatchObject({
        status: "error",
        error: expect.stringMatching(/^Invalid dev update events/),
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  describe("a latest release without latest-linux.yml", () => {
    const realPlatform = process.platform;
    const missingFeed = Object.assign(new Error("Cannot find latest-linux.yml"), {
      code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
    });

    afterEach(() => {
      Object.defineProperty(process, "platform", { value: realPlatform });
    });

    async function checkWith(platform: NodeJS.Platform, error: Error) {
      Object.defineProperty(process, "platform", { value: platform });
      updaterState.checkForUpdates.mockImplementationOnce(() => Promise.reject(error));
      const { registerAutoUpdaterIpc } = await import("./updater");
      const window = mainWindow();
      registerAutoUpdaterIpc({ getMainWindow: () => window });
      const checking = await electronState.handlers.get("app:check-for-updates")?.(trustedEvent());
      expect(checking).toMatchObject({ status: "checking" });
      // The check publishes `checking`, then its outcome.
      await vi.waitFor(() => expect(window.webContents.send).toHaveBeenCalledTimes(2));
      const [channel, outcome] = vi.mocked(window.webContents.send).mock.calls[1];
      expect(channel).toBe("update:state");
      return outcome;
    }

    it("means no update yet on Linux, where the alpha packages are attached by hand", async () => {
      expect(await checkWith("linux", missingFeed)).toMatchObject({
        status: "up-to-date",
        version: "0.1.0",
      });
    });

    it("stays an error on macOS, whose feed every release carries", async () => {
      expect(await checkWith("darwin", missingFeed)).toMatchObject({
        status: "error",
        error: "Cannot find latest-linux.yml",
      });
    });

    it("leaves other Linux update failures as errors", async () => {
      expect(await checkWith("linux", new Error("network down"))).toMatchObject({
        status: "error",
        error: "network down",
      });
    });
  });
});
