import path from "node:path";
import { app, BrowserWindow, dialog, protocol } from "electron";
import { loadDevEnv } from "./env";
import { clearRegisteredFilePaths, registerIpc, registerThemeEvents } from "./ipc";
import { installApplicationMenu } from "./menu";
import { registerPower, shutdownPower } from "./power";
import { refreshBrowserOriginPolicy, setRuntimeConfig } from "./runtime-config";
import { installServiceTransport } from "./service-transport";
import { initAutoUpdater, registerAutoUpdaterIpc, shutdownAutoUpdater } from "./updater";
import {
  createDevSidecarHandle,
  productionDbPath,
  spawnProductionSidecar,
  waitForDevSidecar,
  type SidecarHandle,
  type SidecarStatusUpdate,
} from "./sidecar";
import { createSplashWindow, type SplashHandle } from "./splash";
import { installContextMenu } from "./context-menu";
import { resolveDevProfile, type DevProfile } from "./dev-user-data";
import { sendToWindow } from "./safe-send";
import { registerBrowserIpc } from "./browser-ipc";
import { startBrowserBridgeServer, type BrowserBridgeHandle } from "./browser-bridge-server";
import { dispatchBrowserMcpTool } from "./browser-mcp-dispatch";
import { agentActivityFor } from "./browser-agent-activity";
import type { BrowserManager } from "./browser-manager";
import { handleStartupRecoveryAction } from "./startup-recovery-actions";
import { buildStartupRecovery, type StartupRecoveryState } from "./startup-recovery";
import { installDefaultRendererCrashRecovery } from "./renderer-crash-recovery";
import { configureLinuxOzonePlatform } from "./linux-ozone-platform";
import { installCsp, rendererLoadTarget, secureWebContents } from "./renderer-window-security";
import { registerNotchIpc } from "./notch-ipc";
import type { NotchController } from "./notch-window";
import { PLUGIN_TAB_PRIVILEGED_SCHEME } from "./plugin-tabs/plugin-tab-ids";
import { registerPluginTabIpc } from "./plugin-tabs/plugin-tab-ipc";
import type { PluginTabManager } from "./plugin-tabs/plugin-tab-manager";
import { windowIconOption } from "./app-icon";
import { RESUME_AGENTS, type AppCloseChoice } from "../../src/shared/app-close";
let mainWindow: BrowserWindow | null = null;
let splash: SplashHandle | null = null;
let sidecar: SidecarHandle | null = null;
let allowClose = false;
let pendingQuit = false;
/** What the user chose for working agents when they confirmed the quit. */
let closeChoice: AppCloseChoice = RESUME_AGENTS;
/** The service was told to keep the agents stopped when it stops. */
let stopIntentRecorded = false;
let ipcRegistered = false;
let themeEventsRegistered = false;
let powerRegistered = false;
let updaterRegistered = false;
let sidecarStopPromise: Promise<void> | null = null;
let browserIpcRegistered = false;
let browserManager: BrowserManager | null = null;
let browserBridge: BrowserBridgeHandle | null = null;
let browserFlushPromise: Promise<void> | null = null;
let notch: NotchController | null = null;
let pluginTabs: PluginTabManager | null = null;
let shutdownReady = false;
/** Dev-env load result from module scope; the failure is re-raised by `bootstrap()`. */
let devProfile: DevProfile | null = null;
let startupRecovery: StartupRecoveryState | null = null;

function startupRecoveryDbPath(): string {
  if (app.isPackaged) return productionDbPath();
  return process.env.CADENCR_DB_PATH || productionDbPath();
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
    sidecar = createDevSidecarHandle();
    await waitForDevSidecar(sidecar, (update) => splash?.setPhase(update.phase, update.detail));
  }
  if (!app.isPackaged && browserBridge)
    await registerBrowserBridgeWithService(sidecar, browserBridge);
  setRuntimeConfig({ baseUrl: sidecar.baseUrl, authToken: sidecar.authToken });
  await refreshBrowserOriginPolicy();
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
  sendToWindow(mainWindow, "app:close-requested", { quitting: true });
}

function requestQuit(): void {
  pendingQuit = true;
  sendCloseRequest();
}

function createWindow(): BrowserWindow {
  allowClose = false;
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    ...(process.platform === "linux"
      ? { frame: false }
      : { titleBarStyle: "hiddenInset" as const }),
    ...windowIconOption({
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    }),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  installServiceTransport(win.webContents.session, () => mainWindow);
  secureWebContents(win.webContents);
  installContextMenu(win, win.webContents);
  installDefaultRendererCrashRecovery(win);

  win.on("close", (event) => {
    if (allowClose) return;
    event.preventDefault();
    pendingQuit = false;
    // Only macOS keeps the app, and so its agents, running without a window.
    sendToWindow(win, "app:close-requested", { quitting: process.platform !== "darwin" });
  });
  // The window's own focus, which stays put while a guest view (a custom tab,
  // a browser pane) has it; the renderer's document reports that as a blur.
  win.on("focus", () => sendToWindow(win, "window:focus-changed", true));
  win.on("blur", () => sendToWindow(win, "window:focus-changed", false));
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
    // Guests belong to this window's placeholders; the window (and so the
    // views' parent) is already gone, so they are only closed here.
    pluginTabs?.destroyAll();
    // The island mirrors this window's state; without it there is nothing to show.
    void notch?.setEnabled(false);
  });
  win.webContents.on("did-start-navigation", (details) => {
    clearRegisteredFilePaths();
    // A renderer reload drops every placeholder; orphaned guests would paint over the new UI.
    if (details.isMainFrame && !details.isSameDocument) pluginTabs?.destroyAll();
  });

  const loadTarget = rendererLoadTarget();
  if (loadTarget.kind === "url") void win.loadURL(loadTarget.value);
  else void win.loadFile(loadTarget.value);
  return win;
}

function confirmClose(choice: AppCloseChoice): void {
  allowClose = true;
  closeChoice = choice;
  const closingWindow = mainWindow;
  // The choice goes first, while the window is still up to show a failure:
  // closing the last window quits on Linux.
  void recordCloseChoice()
    .then(() =>
      pendingQuit
        ? stopSidecarThenQuit()
        : prepareBrowserWindowClose().then(() => closingWindow?.close()),
    )
    .catch(handleShutdownFailure);
}

/** Tell the service to keep the agents stopped, when that is the choice. */
async function recordCloseChoice(): Promise<void> {
  if (closeChoice.resumeAgents || !sidecar) return;
  await sidecar.setShutdownIntent(closeChoice);
  stopIntentRecorded = true;
}

function wireMainProcess(): void {
  if (!ipcRegistered) {
    registerIpc({ getMainWindow: () => mainWindow, confirmClose, requestQuit });
    ipcRegistered = true;
  }
  notch ??= registerNotchIpc(() => mainWindow);
  pluginTabs ??= registerPluginTabIpc({
    getMainWindow: () => mainWindow,
    preloadPath: path.join(__dirname, "../preload/plugin-tab.js"),
  });
  if (!browserIpcRegistered) {
    browserManager = registerBrowserIpc({
      getMainWindow: () => mainWindow,
      onSuppressed: (value) => pluginTabs?.setSuppressed(value),
    });
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
  if (!app.isPackaged) {
    // Already loaded at module scope (see the `userData` block below); this is
    // where a failure becomes reportable. Throwing at module scope would land
    // before `whenReady`, outside the startup-recovery catch, and kill the app
    // with nothing on screen at all.
    if (devProfile?.envError) throw devProfile.envError;
    console.info(`Loaded env from ${devProfile?.envPath}`);
  }
  installCsp();
  browserBridge = await startBrowserBridgeServer({
    dispatch: async (toolName, args, featureId) => {
      if (!browserManager) throw new Error("Browser manager is not ready.");
      // Shield the renderer's focus (most visibly the agent prompt) from being
      // stolen by the guest page while the agent drives the browser.
      const manager = browserManager;
      const result = await manager.focusGuard.run(() =>
        dispatchBrowserMcpTool(manager, toolName, args, featureId),
      );
      // Let the renderer follow the agent (auto layout, activity indicator).
      const activity = agentActivityFor(toolName, featureId);
      if (activity) sendToWindow(mainWindow, "browser:agent-activity", activity);
      return result;
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
  // `.env` is loaded in here rather than in `bootstrap()`: it carries the
  // per-worktree profile suffix, and the instance lock below is keyed on the
  // resulting `userData` path, so anything that lands in `process.env` after
  // `app.whenReady()` arrives too late. See `resolveDevProfile`.
  devProfile = resolveDevProfile(app.getPath("appData"), loadDevEnv);
  app.setPath("userData", devProfile.userDataPath);
}

// Electron accepts exactly one privileged-scheme registration, before `ready`:
// every privileged scheme belongs in this single call.
protocol.registerSchemesAsPrivileged([PLUGIN_TAB_PRIVILEGED_SCHEME]);

configureLinuxOzonePlatform(app.commandLine, process.platform);

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
  if (!shutdownReady) {
    event.preventDefault();
    void stopSidecarThenQuit().catch(handleShutdownFailure);
  }
});

async function prepareForUpdateInstall(): Promise<void> {
  await prepareBrowserShutdown();
  allowClose = true;
  pendingQuit = false;
  shutdownPower();
  powerRegistered = false;
  shutdownAutoUpdater();
  await stopSidecarForExit();
  await stopBrowserBridge();
  shutdownReady = true;
}

async function stopSidecarThenQuit(): Promise<void> {
  await prepareBrowserShutdown();
  await stopSidecarForExit();
  await stopBrowserBridge();
  shutdownReady = true;
  app.quit();
}

async function prepareBrowserShutdown(): Promise<void> {
  if (!browserManager) return;
  browserFlushPromise ??= browserManager.prepareForShutdown().finally(() => {
    browserFlushPromise = null;
  });
  await browserFlushPromise;
}

async function prepareBrowserWindowClose(): Promise<void> {
  if (!browserManager) return;
  await browserManager.prepareForWindowClose();
}

function handleShutdownFailure(error: unknown): void {
  allowClose = false;
  pendingQuit = false;
  closeChoice = RESUME_AGENTS;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Could not complete shutdown safely: ${message}`);
  dialog.showErrorBox("Could not close Cadencr", message);
  // Cadencr keeps running: a later stop (an update) must resume the agents.
  if (stopIntentRecorded && sidecar) {
    stopIntentRecorded = false;
    void sidecar.setShutdownIntent(RESUME_AGENTS).catch((resetError: unknown) => {
      const detail = resetError instanceof Error ? resetError.message : String(resetError);
      dialog.showErrorBox("Cadencr may not resume your agents after a restart", detail);
    });
  }
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
  // The notch island is a window too, but never a reason not to reopen the app.
  const appWindows = BrowserWindow.getAllWindows().filter(
    (win) => notch?.windowForSender(win.webContents.id) !== win,
  );
  if (appWindows.length === 0) {
    mainWindow = createWindow();
    wireMainProcess();
  }
});
