import path from "node:path";
import { app, BrowserWindow, dialog, session, shell, type WebContents } from "electron";
import { rendererCsp } from "./csp";
import { loadDevEnv } from "./env";
import { clearRegisteredFilePaths, registerIpc, registerThemeEvents } from "./ipc";
import { installApplicationMenu } from "./menu";
import { registerPower, shutdownPower } from "./power";
import { approvedExternalUrl, isAllowedNavigationUrl, isLoopbackDevUrl } from "./navigation";
import { setRuntimeConfig } from "./runtime-config";
import { initAutoUpdater, registerAutoUpdaterIpc, shutdownAutoUpdater } from "./updater";
import {
  createDevSidecarHandle,
  productionDbPath,
  spawnProductionSidecar,
  type SidecarHandle,
  type SidecarStatusUpdate,
} from "./sidecar";
import { createSplashWindow, type SplashHandle } from "./splash";
import { installContextMenu } from "./context-menu";
import { devUserDataPath } from "./dev-user-data";
import { sendToWindow } from "./safe-send";
import { registerBrowserIpc } from "./browser-ipc";
import { startBrowserBridgeServer, type BrowserBridgeHandle } from "./browser-bridge-server";
import { dispatchBrowserMcpTool } from "./browser-mcp-dispatch";
import type { BrowserManager } from "./browser-manager";
import { handleStartupRecoveryAction } from "./startup-recovery-actions";
import { buildStartupRecovery, type StartupRecoveryState } from "./startup-recovery";
import { installDefaultRendererCrashRecovery } from "./renderer-crash-recovery";
let mainWindow: BrowserWindow | null = null;
let splash: SplashHandle | null = null;
let sidecar: SidecarHandle | null = null;
let allowClose = false;
let pendingQuit = false;
let ipcRegistered = false;
let themeEventsRegistered = false;
let powerRegistered = false;
let updaterRegistered = false;
let sidecarStopPromise: Promise<void> | null = null;
let browserIpcRegistered = false;
let browserManager: BrowserManager | null = null;
let browserBridge: BrowserBridgeHandle | null = null;
let startupRecovery: StartupRecoveryState | null = null;

function startupRecoveryDbPath(): string {
  if (app.isPackaged) return productionDbPath();
  return process.env.CADENCR_DB_PATH || productionDbPath();
}

function installCsp(): void {
  const csp = rendererCsp(app.isPackaged);
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
      },
    });
  });
}

async function prepareRuntime(): Promise<void> {
  if (app.isPackaged) {
    sidecar = await spawnProductionSidecar({
      appVersion: app.getVersion(),
      browserBridge: browserBridge
        ? { url: browserBridge.url, token: browserBridge.token }
        : undefined,
      onStatus: (update: SidecarStatusUpdate) => splash?.setPhase(update.phase, update.detail),
    });
  } else {
    const dotenvPath = loadDevEnv();
    console.info(`Loaded env from ${dotenvPath}`);
    sidecar = createDevSidecarHandle();
  }
  if (!app.isPackaged && browserBridge)
    await registerBrowserBridgeWithService(sidecar, browserBridge);
  setRuntimeConfig({ baseUrl: sidecar.baseUrl, authToken: sidecar.authToken });
}

async function registerBrowserBridgeWithService(
  handle: SidecarHandle,
  bridge: BrowserBridgeHandle,
): Promise<void> {
  if (!handle.authToken) {
    throw new Error("Cannot register Browser bridge: service auth token is missing.");
  }
  const response = await retryBrowserBridgeRegistration(handle, bridge);
  if (!response.ok) {
    throw new Error(
      `Cannot register Browser bridge: service returned ${response.status} ${await response.text()}`,
    );
  }
}

async function retryBrowserBridgeRegistration(
  handle: SidecarHandle,
  bridge: BrowserBridgeHandle,
): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      return await fetch(`${handle.baseUrl}/api/browser-bridge`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-cadencr-token": handle.authToken ?? "",
        },
        body: JSON.stringify({ url: bridge.url, token: bridge.token }),
      });
    } catch (error) {
      lastError = error;
      if (attempt < 59) await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Cannot register Browser bridge: ${String(lastError)}`);
}

function sendCloseRequest(): void {
  sendToWindow(mainWindow, "app:close-requested");
}

function requestQuit(): void {
  pendingQuit = true;
  sendCloseRequest();
}

function rendererLoadUrl(): { kind: "url"; value: string } | { kind: "file"; value: string } {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && rendererUrl) {
    if (!isLoopbackDevUrl(rendererUrl)) {
      throw new Error(`Rejected untrusted ELECTRON_RENDERER_URL: ${rendererUrl}`);
    }
    return { kind: "url", value: rendererUrl };
  }
  return {
    kind: "file",
    value: path.join(__dirname, "../renderer/index.html"),
  };
}

function secureWebContents(webContents: WebContents): void {
  webContents.setWindowOpenHandler(({ url }) => {
    void openApprovedExternalUrl(url);
    return { action: "deny" };
  });
  webContents.on("will-navigate", (event, url) => {
    if (isAllowedNavigationUrl(url, app.isPackaged)) return;
    event.preventDefault();
    void openApprovedExternalUrl(url);
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    // The renderer's async Clipboard API (`navigator.clipboard.writeText` /
    // `.write`) requires `clipboard-sanitized-write` to be granted; without
    // it the write rejects with `NotAllowedError`. Sanitized writes only
    // emit standard MIME types, so granting this is safe.
    if (permission === "clipboard-sanitized-write") {
      callback(true);
      return;
    }
    callback(false);
  });
}

async function openApprovedExternalUrl(rawUrl: string): Promise<void> {
  const url = approvedExternalUrl(rawUrl);
  if (url) await shell.openExternal(url);
}

function createWindow(): BrowserWindow {
  allowClose = false;
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  secureWebContents(win.webContents);
  installContextMenu(win, win.webContents);
  installDefaultRendererCrashRecovery(win);

  win.on("close", (event) => {
    if (allowClose) return;
    event.preventDefault();
    pendingQuit = false;
    sendToWindow(win, "app:close-requested");
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  win.webContents.on("did-start-navigation", () => clearRegisteredFilePaths());

  const loadTarget = rendererLoadUrl();
  if (loadTarget.kind === "url") void win.loadURL(loadTarget.value);
  else void win.loadFile(loadTarget.value);
  return win;
}

function confirmClose(): void {
  allowClose = true;
  if (pendingQuit) app.quit();
  else mainWindow?.close();
}

function wireMainProcess(): void {
  if (!ipcRegistered) {
    registerIpc({ getMainWindow: () => mainWindow, confirmClose, requestQuit });
    ipcRegistered = true;
  }
  if (!browserIpcRegistered) {
    browserManager = registerBrowserIpc({ getMainWindow: () => mainWindow });
    browserIpcRegistered = true;
  }
  if (!themeEventsRegistered) {
    registerThemeEvents(() => mainWindow);
    themeEventsRegistered = true;
  }
  if (!powerRegistered) {
    registerPower({ getMainWindow: () => mainWindow });
    powerRegistered = true;
  }
  if (!updaterRegistered) {
    registerAutoUpdaterIpc({
      getMainWindow: () => mainWindow,
      prepareInstallUpdate: prepareForUpdateInstall,
    });
    initAutoUpdater({ getMainWindow: () => mainWindow });
    updaterRegistered = true;
  }
}

async function bootstrap(): Promise<void> {
  installCsp();
  browserBridge = await startBrowserBridgeServer({
    dispatch: (toolName, args, featureId) => {
      if (!browserManager) throw new Error("Browser manager is not ready.");
      // Shield the renderer's focus (most visibly the agent prompt) from being
      // stolen by the guest page while the agent drives the browser.
      const manager = browserManager;
      return manager.focusGuard.run(() =>
        dispatchBrowserMcpTool(manager, toolName, args, featureId),
      );
    },
  });
  installApplicationMenu(requestQuit);
  splash = createSplashWindow(app.getVersion());
  splash.setPhase("starting");
  // Cmd+W (or any user-driven close on the splash) means "I want out" — the
  // main window may not exist yet, so the regular close-confirm flow can't
  // run. Quit immediately and let `before-quit` clean up the sidecar.
  splash.onUserClose(() => {
    splash = null;
    app.quit();
  });
  splash.onAction((action) => {
    void handleStartupRecoveryAction({
      action,
      recovery: startupRecovery,
      splash,
      quit: () => {
        allowClose = true;
        app.quit();
      },
    });
  });
  await prepareRuntime();
  mainWindow = createWindow();
  mainWindow.webContents.once("did-finish-load", closeSplash);
  wireMainProcess();
}

function closeSplash(): void {
  if (!splash) return;
  splash.close();
  splash = null;
}

app.setAppUserModelId(app.isPackaged ? "com.cadencr.desktop" : "com.cadencr.desktop.dev");

if (!app.isPackaged) {
  app.setName("Cadencr Dev");
  const devUserData = devUserDataPath(
    app.getPath("appData"),
    process.env.CADENCR_DEV_USER_DATA_SUFFIX,
  );
  app.setPath("userData", devUserData);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
  throw new Error("second instance — exiting");
}
app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  } else if (splash) {
    splash.window.focus();
  }
});

app
  .whenReady()
  .then(() => bootstrap())
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    startupRecovery = buildStartupRecovery({
      appVersion: app.getVersion(),
      getDbPath: startupRecoveryDbPath,
      message,
      now: new Date(),
      platform: process.platform,
    });
    if (splash) {
      splash.setError(startupRecovery.title, startupRecovery.detail, startupRecovery.actions);
    } else {
      dialog.showErrorBox(startupRecovery.title, startupRecovery.detail);
      app.quit();
    }
  });

app.on("before-quit", (event) => {
  if (!allowClose && mainWindow) {
    event.preventDefault();
    requestQuit();
    return;
  }
  if (sidecar) {
    event.preventDefault();
    void stopSidecarThenQuit();
  }
});

async function prepareForUpdateInstall(): Promise<void> {
  allowClose = true;
  pendingQuit = false;
  shutdownPower();
  powerRegistered = false;
  shutdownAutoUpdater();
  await stopSidecarForExit();
  await stopBrowserBridge();
}

async function stopSidecarThenQuit(): Promise<void> {
  await stopSidecarForExit();
  await stopBrowserBridge();
  app.quit();
}

async function stopBrowserBridge(): Promise<void> {
  if (!browserBridge) return;
  await browserBridge.stop();
  browserBridge = null;
}

async function stopSidecarForExit(): Promise<void> {
  if (!sidecarStopPromise) {
    const currentSidecar = sidecar;
    if (!currentSidecar) return;
    sidecar = null;
    closeAllWindowsForQuit();
    // Release any held power-save-blocker and unwire power listeners before
    // the sidecar stop awaits, so quit cleans up the OS-level state even
    // if the sidecar takes a moment to shut down.
    shutdownPower();
    powerRegistered = false;
    shutdownAutoUpdater();
    sidecarStopPromise = currentSidecar.stop().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to stop cadencr-service cleanly: ${message}`);
    });
  }
  await sidecarStopPromise;
}

function closeAllWindowsForQuit(): void {
  allowClose = true;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.close();
  }
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow();
    wireMainProcess();
  }
});
