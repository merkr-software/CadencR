import { join } from "node:path";
import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import pkg from "electron-updater";
import { z } from "zod";
import type { ChangelogImageBytes } from "../../src/shared/changelog-image";
import { fetchChangelogImage } from "./changelog-images";
import { assertTrustedSender } from "./ipc";
import { GH_OWNER, GH_REPO } from "./release-repo";
import { detectLinuxInstallType, type LinuxInstallType } from "./linux-install-type";
import { devUpdateEvents, UpdateStateAuthority } from "./update-state-authority";
import type { UpdateEvent, UpdateSnapshot } from "../../src/shared/update-state";

// `electron-updater` ships as CommonJS; the `autoUpdater` named export is on
// the default module object when imported from ESM/TS.
const { autoUpdater } = pkg;

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const FIRST_CHECK_DELAY_MS = 10_000; // 10 s after ready — let the sidecar boot

const CHANGELOG_FETCH_TIMEOUT_MS = 8_000;

let initialized = false;
let registered = false;
let intervalHandle: NodeJS.Timeout | null = null;
let state: UpdateStateAuthority | null = null;

/** The process-wide update state; the first caller's window getter publishes it. */
function updateState(getMainWindow: () => BrowserWindow | null): UpdateStateAuthority {
  state ??= new UpdateStateAuthority(getMainWindow);
  return state;
}

/**
 * Returns the Linux install type when electron-updater cannot service this
 * build. Official AppImage, DEB, and RPM packages all update from GitHub
 * Releases; only unrecognized/custom Linux packages are unsupported.
 */
let cachedUnsupported: LinuxInstallType | null | undefined;
function unsupportedInstall(): LinuxInstallType | null {
  if (cachedUnsupported !== undefined) return cachedUnsupported;
  if (process.platform !== "linux") return (cachedUnsupported = null);
  const packageTypePath =
    typeof process.resourcesPath === "string"
      ? join(process.resourcesPath, "package-type")
      : undefined;
  const installType = detectLinuxInstallType(process.env, packageTypePath);
  return (cachedUnsupported = installType === "unknown" ? installType : null);
}

const UNSUPPORTED_INSTALL_MESSAGE =
  "This Linux build is not an official AppImage, DEB, or RPM package. Download an official build from GitHub Releases to enable in-app updates.";
const UNSUPPORTED_EVENT: UpdateEvent = {
  kind: "unsupported",
  reason: "unsupported-install",
  message: UNSUPPORTED_INSTALL_MESSAGE,
};

interface InitOptions {
  getMainWindow: () => BrowserWindow | null;
  prepareInstallUpdate?: () => Promise<void> | void;
}

export function registerAutoUpdaterIpc({ getMainWindow, prepareInstallUpdate }: InitOptions): void {
  if (registered) return;
  registered = true;
  const updates = updateState(getMainWindow);
  ipcMain.handle("app:update-state", (event: IpcMainInvokeEvent): UpdateSnapshot => {
    assertTrustedSender(event, getMainWindow);
    return updates.snapshot();
  });
  // Resolves with the state the check moved to, so the caller never guesses it.
  ipcMain.handle("app:check-for-updates", (event: IpcMainInvokeEvent): UpdateSnapshot => {
    assertTrustedSender(event, getMainWindow);
    if (!app.isPackaged) {
      return updates.apply({ kind: "error", message: "Updates are disabled in dev builds." });
    }
    if (unsupportedInstall()) return updates.apply(UNSUPPORTED_EVENT);
    const checking = updates.apply({ kind: "checking" });
    void autoUpdater.checkForUpdates().catch((error: unknown) => {
      reportUpdateFailure(updates, error);
    });
    return checking;
  });
  ipcMain.handle("app:install-update", async (event: IpcMainInvokeEvent) => {
    assertTrustedSender(event, getMainWindow);
    if (!app.isPackaged) return;
    if (unsupportedInstall()) {
      // Renderer should never reach this path because the install button is
      // hidden, but surface the same explanation rather than silently no-op.
      updates.apply(UNSUPPORTED_EVENT);
      return;
    }
    try {
      await prepareInstallUpdate?.();
      // Keep the installer interactive so DEB/RPM builds can request elevation,
      // then relaunch Cadencr after the package has been replaced.
      autoUpdater.quitAndInstall(false, true);
    } catch (error: unknown) {
      updates.apply({ kind: "error", message: errorMessage(error) });
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
  ipcMain.handle(
    "app:fetch-changelog-image",
    async (event: IpcMainInvokeEvent, src: unknown): Promise<ChangelogImageBytes> => {
      assertTrustedSender(event, getMainWindow);
      const source = z.string().safeParse(src);
      if (!source.success) throw new Error("Image source must be a string.");
      return fetchChangelogImage(source.data);
    },
  );
}

export function initAutoUpdater({ getMainWindow }: InitOptions): void {
  if (initialized) return;
  initialized = true;
  const updates = updateState(getMainWindow);
  if (!app.isPackaged) {
    console.info("[updater] dev build — skipping auto-update setup");
    seedDevUpdateState(updates);
    return;
  }

  const unsupported = unsupportedInstall();
  if (unsupported) {
    console.info(`[updater] linux ${unsupported} install — auto-update disabled`);
    // The renderer reads this state when it mounts, whenever that is.
    updates.apply(UNSUPPORTED_EVENT);
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = console;

  autoUpdater.on("checking-for-update", () => {
    updates.apply({ kind: "checking" });
  });
  autoUpdater.on("update-available", (info) => {
    // Publish the update immediately so the sidebar can light up; the
    // changelog body arrives as its own event once GitHub responds, which
    // keeps `reduceUpdateSnapshot` linear (no special-casing a second
    // `available`) and lets download progress flow in the meantime.
    updates.apply({ kind: "available", version: info.version });
    void fetchChangelog(info.version).then((markdown) => {
      updates.apply({ kind: "changelog", version: info.version, markdown });
    });
  });
  autoUpdater.on("update-not-available", (info) => {
    updates.apply({ kind: "not-available", version: info.version ?? app.getVersion() });
  });
  autoUpdater.on("error", (error) => {
    reportUpdateFailure(updates, error);
  });
  autoUpdater.on("download-progress", (progress) => {
    updates.apply({
      kind: "download-progress",
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    updates.apply({ kind: "downloaded", version: info.version });
  });

  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch((error: unknown) => {
      reportUpdateFailure(updates, error);
    });
  }, FIRST_CHECK_DELAY_MS);

  intervalHandle = setInterval(() => {
    void autoUpdater.checkForUpdates().catch((error: unknown) => {
      reportUpdateFailure(updates, error);
    });
  }, CHECK_INTERVAL_MS);
}

export function shutdownAutoUpdater(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

/** Dev builds have no feed: replay `CADENCR_DEV_UPDATE_EVENTS` so the UI can be exercised. */
function seedDevUpdateState(updates: UpdateStateAuthority): void {
  try {
    for (const event of devUpdateEvents(process.env)) updates.apply(event);
  } catch (error) {
    updates.apply({ kind: "error", message: `Invalid dev update events: ${errorMessage(error)}` });
  }
}

/**
 * Linux packages are attached to a release by hand, after macOS ships, so the
 * latest release can lack `latest-linux.yml`. That means no Linux update yet,
 * not a failed check: report it as "not available" instead of an error.
 */
function isMissingLinuxFeed(error: unknown): boolean {
  return (
    process.platform === "linux" &&
    error instanceof Error &&
    "code" in error &&
    error.code === "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND"
  );
}

function reportUpdateFailure(updates: UpdateStateAuthority, error: unknown): void {
  if (isMissingLinuxFeed(error)) {
    console.info("[updater] the latest release has no Linux packages yet");
    updates.apply({ kind: "not-available", version: app.getVersion() });
    return;
  }
  updates.apply({ kind: "error", message: errorMessage(error) });
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
