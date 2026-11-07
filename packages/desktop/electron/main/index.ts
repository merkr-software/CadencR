import path from "node:path";
import { installMainTelemetry } from "./main-telemetry";
import { closeAllWindowsForQuit } from "./window-shutdown";
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
  waitForDevSidecar,
  type SidecarHandle,
  type SidecarStatusUpdate,
} from "./sidecar";
import { createSplashWindow, type SplashHandle } from "./splash";
import { installContextMenu } from "./context-menu";
import { resolveDevProfile, type DevProfile } from "./dev-user-data";
import { sendToWindow } from "./safe-send";
import {
  registerBrowserBridgeWithService,
  startAgentBrowserBridge,
} from "./service-browser-bridge";
import { registerAppLifecycleIpc } from "./app-lifecycle-ipc";
import { createCloseCoordinator, windowCloseQuits } from "./close-coordinator";
import { createPackagedService } from "./packaged-service";
import { RendererHealth } from "./renderer-health";
import { registerBrowserIpc } from "./browser-ipc";
import type { BrowserBridgeHandle } from "./browser-bridge-server";
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
import {
  RESUME_AGENTS,
  type AppCloseChoice,
  type AppCloseRequest,
} from "../../src/shared/app-close";
let mainWindow: BrowserWindow | null = null;
let splash: SplashHandle | null = null;
let sidecar: SidecarHandle | null = null;
let allowClose = false;
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
  const onStatus = (update: SidecarStatusUpdate): void =>
    splash?.setPhase(update.phase, update.detail);
  if (app.isPackaged) {
    await adoptSidecar(await packagedService.spawn(onStatus));
    return;
  }
  const devSidecar = createDevSidecarHandle();
  await waitForDevSidecar(devSidecar, onStatus);
  if (browserBridge) await registerBrowserBridgeWithService(devSidecar, browserBridge);
  await adoptSidecar(devSidecar);
}

async function adoptSidecar(handle: SidecarHandle): Promise<void> {
  sidecar = handle;
  setRuntimeConfig({ baseUrl: handle.baseUrl, authToken: handle.authToken });
  await refreshBrowserOriginPolicy();
}

const packagedService = createPackagedService({
  appVersion: app.getVersion(),
  browserBridge: () =>
    browserBridge ? { url: browserBridge.url, token: browserBridge.token } : undefined,
  shuttingDown: () => sidecarStopPromise !== null,
  adopt: adoptSidecar,
  publish: (status) => sendToWindow(mainWindow, "service:status", status),
});
const serviceSupervisor = packagedService.supervisor;

const closeCoordinator = createCloseCoordinator({
  renderer: {
    canAnswer: () => rendererHealth.canAnswer(mainWindow),
    ask: (request) => sendToWindow(mainWindow, "app:close-requested", request),
  },
  finish: finishClose,
  reportUnanswered: (request, reason) =>
    console.warn(
      `${request.quitting ? "Quitting" : "Closing the window"} without confirmation: ${reason}.`,
    ),
});

// A crashed or hung renderer cannot confirm a close; a waiting one goes ahead.
const rendererHealth = new RendererHealth(() => closeCoordinator.rendererLost());

function requestQuit(): void {
  closeCoordinator.request(true);
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
    closeCoordinator.request(windowCloseQuits(process.platform));
  });
  rendererHealth.watch(win);
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
    if (details.isMainFrame && !details.isSameDocument) {
      pluginTabs?.destroyAll();
      // A reload took any open confirmation with it.
      closeCoordinator.rendererReset();
    }
  });

  const loadTarget = rendererLoadTarget();
  if (loadTarget.kind === "url") void win.loadURL(loadTarget.value);
  else void win.loadFile(loadTarget.value);
  return win;
}

function finishClose(request: AppCloseRequest, choice: AppCloseChoice): void {
  allowClose = true;
  closeChoice = choice;
  const closingWindow = mainWindow;
  // The choice goes first, while the window is still up to show a failure:
  // closing the last window quits on Linux.
  void recordCloseChoice()
    .then(() =>
      request.quitting
        ? stopSidecarThenQuit()
        : prepareBrowserWindowClose().then(() => rendererHealth.closeNow(closingWindow)),
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
    registerIpc({ getMainWindow: () => mainWindow });
    registerAppLifecycleIpc({
      getMainWindow: () => mainWindow,
      appClose: {
        confirm: closeCoordinator.confirm,
        acknowledge: closeCoordinator.acknowledge,
        cancel: closeCoordinator.cancel,
        requestQuit,
      },
      service: { status: serviceSupervisor.status, restart: serviceSupervisor.restart },
    });
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
  browserBridge = await startAgentBrowserBridge(
    () => browserManager,
    () => mainWindow,
  );
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

installMainTelemetry();

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
  closeCoordinator.cancel();
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
    allowClose = true;
    serviceSupervisor.stopSupervising();
    closeAllWindowsForQuit((win) => win === mainWindow && !rendererHealth.canAnswer(win));
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
