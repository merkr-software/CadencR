import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import pkg from "electron-updater";
import { assertTrustedSender } from "./ipc";
import { detectLinuxInstallType, type LinuxInstallInfo } from "./linux-install-type";
import { sendToWindow } from "./safe-send";

// `electron-updater` ships as CommonJS; the `autoUpdater` named export is on
// the default module object when imported from ESM/TS.
const { autoUpdater } = pkg;

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const FIRST_CHECK_DELAY_MS = 10_000; // 10 s after ready — let the sidecar boot

// GitHub repo backing the public releases / changelog. Matches the `publish`
// block in `electron-builder.yml`.
const GH_OWNER = "merkr-software";
const GH_REPO = "cadencr";
const CHANGELOG_FETCH_TIMEOUT_MS = 8_000;

type UpdateChannel =
  | { channel: "update:checking" }
  | { channel: "update:available"; version: string }
  | { channel: "update:changelog"; version: string; markdown: string | null }
  | { channel: "update:not-available"; version: string }
  | { channel: "update:error"; message: string }
  | { channel: "update:download-progress"; percent: number; bytesPerSecond: number }
  | { channel: "update:downloaded"; version: string }
  | { channel: "update:unsupported"; reason: "package-manager"; message: string };

let initialized = false;
let registered = false;
let intervalHandle: NodeJS.Timeout | null = null;
let unsupportedAnnounceTimeout: NodeJS.Timeout | null = null;

/**
 * Returns install info when the in-app updater can't service this build
 * (Linux deb / rpm / unknown); null on AppImage, macOS, Windows. Cached
 * after first call — `/etc/os-release` doesn't change mid-session, so the
 * syscall is paid once. Drives both the IPC handlers and `initAutoUpdater`.
 */
let cachedUnsupported: LinuxInstallInfo | null | undefined;
function unsupportedInstall(): LinuxInstallInfo | null {
  if (cachedUnsupported !== undefined) return cachedUnsupported;
  if (process.platform !== "linux") return (cachedUnsupported = null);
  const info = detectLinuxInstallType();
  return (cachedUnsupported = info.type === "appimage" ? null : info);
}

interface InitOptions {
  getMainWindow: () => BrowserWindow | null;
  prepareInstallUpdate?: () => Promise<void> | void;
}

export function registerAutoUpdaterIpc({ getMainWindow, prepareInstallUpdate }: InitOptions): void {
  if (registered) return;
  registered = true;
  ipcMain.handle("app:check-for-updates", (event: IpcMainInvokeEvent) => {
    assertTrustedSender(event, getMainWindow);
    if (!app.isPackaged) {
      sendUpdate(getMainWindow, {
        channel: "update:error",
        message: "Updates are disabled in dev builds.",
      });
      return;
    }
    const unsupported = unsupportedInstall();
    if (unsupported) {
      sendUpdate(getMainWindow, {
        channel: "update:unsupported",
        reason: "package-manager",
        message: unsupported.message,
      });
      return;
    }
    void autoUpdater.checkForUpdates().catch((error: unknown) => {
      sendUpdate(getMainWindow, { channel: "update:error", message: errorMessage(error) });
    });
  });
  ipcMain.handle("app:install-update", async (event: IpcMainInvokeEvent) => {
    assertTrustedSender(event, getMainWindow);
    if (!app.isPackaged) return;
    const unsupported = unsupportedInstall();
    if (unsupported) {
      // Renderer should never reach this path (the install button is hidden
      // for unsupported installs), but if it does we surface the same hint
      // rather than silently ignoring the call — per error-handling.md.
      sendUpdate(getMainWindow, {
        channel: "update:unsupported",
        reason: "package-manager",
        message: unsupported.message,
      });
      return;
    }
    try {
      await prepareInstallUpdate?.();
      // `quitAndInstall(isSilent, isForceRunAfter)` — silent install, relaunch.
      autoUpdater.quitAndInstall(false, true);
    } catch (error: unknown) {
      const message = errorMessage(error);
      sendUpdate(getMainWindow, { channel: "update:error", message });
      throw error;
    }
  });
  ipcMain.handle(
    "app:fetch-changelog",
    async (event: IpcMainInvokeEvent, version: unknown): Promise<string | null> => {
      assertTrustedSender(event, getMainWindow);
      if (typeof version !== "string" || version.length === 0) return null;
      return fetchChangelog(version);
    },
  );
}

export function initAutoUpdater({ getMainWindow }: InitOptions): void {
  if (initialized) return;
  initialized = true;
  if (!app.isPackaged) {
    console.info("[updater] dev build — skipping auto-update setup");
    return;
  }

  const unsupported = unsupportedInstall();
  if (unsupported) {
    console.info(`[updater] linux ${unsupported.type} install — auto-update disabled`);
    // Push the state to the renderer once the window exists so the About
    // section can render "managed by your package manager" instead of an
    // empty status line. We defer with the same delay as the first
    // AppImage check so the splash has time to hand off to the main window.
    // Defer the announce so the renderer's `useAutoUpdateBridge` effect has
    // mounted and called `onUpdateEvent` before we fire — otherwise the IPC
    // message is delivered to nobody. Tracked so `shutdownAutoUpdater` can
    // cancel it if the app quits within the delay window.
    unsupportedAnnounceTimeout = setTimeout(() => {
      unsupportedAnnounceTimeout = null;
      sendUpdate(getMainWindow, {
        channel: "update:unsupported",
        reason: "package-manager",
        message: unsupported.message,
      });
    }, FIRST_CHECK_DELAY_MS);
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = console;

  autoUpdater.on("checking-for-update", () => {
    sendUpdate(getMainWindow, { channel: "update:checking" });
  });
  autoUpdater.on("update-available", (info) => {
    // Notify the renderer immediately so the sidebar can light up; the
    // changelog body arrives separately once GitHub responds. Splitting the
    // two events keeps the store's `applyEvent` reducer linear (no special-
    // casing a second `available` fire) and prevents the second emit from
    // racing with `download-progress`.
    sendUpdate(getMainWindow, { channel: "update:available", version: info.version });
    void fetchChangelog(info.version).then((markdown) => {
      sendUpdate(getMainWindow, {
        channel: "update:changelog",
        version: info.version,
        markdown,
      });
    });
  });
  autoUpdater.on("update-not-available", (info) => {
    sendUpdate(getMainWindow, {
      channel: "update:not-available",
      version: info.version ?? app.getVersion(),
    });
  });
  autoUpdater.on("error", (error) => {
    sendUpdate(getMainWindow, { channel: "update:error", message: errorMessage(error) });
  });
  autoUpdater.on("download-progress", (progress) => {
    sendUpdate(getMainWindow, {
      channel: "update:download-progress",
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    sendUpdate(getMainWindow, { channel: "update:downloaded", version: info.version });
  });

  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch((error: unknown) => {
      sendUpdate(getMainWindow, { channel: "update:error", message: errorMessage(error) });
    });
  }, FIRST_CHECK_DELAY_MS);

  intervalHandle = setInterval(() => {
    void autoUpdater.checkForUpdates().catch((error: unknown) => {
      sendUpdate(getMainWindow, { channel: "update:error", message: errorMessage(error) });
    });
  }, CHECK_INTERVAL_MS);
}

export function shutdownAutoUpdater(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  if (unsupportedAnnounceTimeout) {
    clearTimeout(unsupportedAnnounceTimeout);
    unsupportedAnnounceTimeout = null;
  }
}

function sendUpdate(getMainWindow: () => BrowserWindow | null, payload: UpdateChannel): void {
  const { channel, ...data } = payload;
  sendToWindow(getMainWindow(), channel, data);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// --- GitHub changelog fetching ---------------------------------------------

/** Process-lifetime cache of release-notes lookups, keyed by `v{semver}`. */
const changelogCache = new Map<string, string | null>();

interface GithubReleasePayload {
  tag_name?: unknown;
  body?: unknown;
}

/**
 * Fetch the markdown release notes for `version` from the GitHub Releases
 * API. Returns `null` when the release doesn't exist or the request fails.
 * Accepts either `"0.2.0"` or `"v0.2.0"`.
 */
export async function fetchChangelog(version: string): Promise<string | null> {
  const tag = version.startsWith("v") ? version : `v${version}`;
  if (changelogCache.has(tag)) return changelogCache.get(tag) ?? null;

  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/releases/tags/${encodeURIComponent(tag)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHANGELOG_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": `Cadencr/${app.getVersion()}`,
      },
    });
    if (!res.ok) {
      changelogCache.set(tag, null);
      return null;
    }
    const payload = (await res.json()) as GithubReleasePayload;
    const body = typeof payload.body === "string" ? payload.body.trim() : "";
    const result = body.length > 0 ? body : null;
    changelogCache.set(tag, result);
    return result;
  } catch (error) {
    console.warn(`[updater] fetchChangelog(${tag}) failed:`, errorMessage(error));
    return null;
  } finally {
    clearTimeout(timer);
  }
}
