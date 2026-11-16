import { WebContentsView, type Session, type WebContents } from "electron";

import type { PluginTabKeyInput } from "../../../src/shared/plugin-tab-host";
import { isOwnPluginTabUrl, pluginTabEntryUrl, pluginTabPartition } from "./plugin-tab-ids";

// net::ERR_ABORTED: a navigation we (or the page) cancelled, or one superseded
// by a newer load — never a real failure worth a placeholder.
const ERR_ABORTED = -3;

export interface PluginTabGuestHooks {
  loaded: () => void;
  loadFailed: (detail: string) => void;
  crashed: (detail: string) => void;
  /** A key pressed in the guest; `true` takes it from the page (a shortcut). */
  keyDown: (input: PluginTabKeyInput) => boolean;
}

export interface PluginTabGuestOptions {
  pluginId: string;
  background: string;
  hooks: PluginTabGuestHooks;
}

export interface PluginTabGuestEnv {
  preloadPath: string;
  /** Installs the partition's protocol handler + hardening (idempotent). */
  prepareSession: (pluginId: string) => Session;
}

export interface PluginTabGuest {
  readonly view: WebContentsView;
  readonly webContents: WebContents;
  /** Close the guest; its later events (e.g. `render-process-gone`) are ignored. */
  destroy: () => void;
}

export function pluginTabWebPreferences(
  pluginId: string,
  preloadPath: string,
): Electron.WebPreferences {
  return {
    partition: pluginTabPartition(pluginId),
    preload: preloadPath,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    plugins: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    spellcheck: false,
    safeDialogs: true,
    devTools: true,
  };
}

/** Navigation never leaves `cadencr-tab://<id>/`; popups never open. */
function installNavigationGuards(wc: WebContents, pluginId: string): void {
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  const guard = (event: { url: string; preventDefault: () => void }): void => {
    if (!isOwnPluginTabUrl(event.url, pluginId)) event.preventDefault();
  };
  wc.on("will-navigate", guard);
  wc.on("will-frame-navigate", guard);
  wc.on("will-redirect", guard);
  wc.on("will-attach-webview", (event) => event.preventDefault());
}

/**
 * Load outcome. `did-fail-load` covers network-level failures; an HTTP error
 * from the asset relay (404 entry, 502 service down) still "finishes loading",
 * so `did-navigate`'s status code turns it into a failure too and suppresses
 * the `loaded` signal (no port is bootstrapped into an error page). One report
 * per load: the rejected `loadURL` promise and `did-fail-load` describe the
 * same failure.
 */
function installLoadEvents(wc: WebContents, hooks: PluginTabGuestHooks, isLive: () => boolean) {
  let failed = false;
  const fail = (detail: string): void => {
    if (failed || !isLive()) return;
    failed = true;
    hooks.loadFailed(detail);
  };
  wc.on("did-start-loading", () => {
    failed = false;
  });
  wc.on("did-navigate", (_event, _url, httpResponseCode, httpStatusText) => {
    if (httpResponseCode >= 400) fail(`HTTP ${httpResponseCode} ${httpStatusText}`.trim());
  });
  wc.on("did-fail-load", (_event, errorCode, errorDescription, _url, isMainFrame) => {
    if (isMainFrame && errorCode !== ERR_ABORTED) fail(`${errorDescription} (${errorCode})`);
  });
  wc.on("did-finish-load", () => {
    if (!failed && isLive()) hooks.loaded();
  });
  return fail;
}

function isAbortedLoad(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "errno" in error && error.errno === ERR_ABORTED
  );
}

function installShortcutRelay(wc: WebContents, hooks: PluginTabGuestHooks): void {
  // A focused guest swallows keydown before the renderer sees it: the host
  // matches every key first (plugin-tab-shortcuts.ts).
  wc.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const taken = hooks.keyDown({
      key: input.key,
      code: input.code,
      meta: input.meta,
      control: input.control,
      alt: input.alt,
      shift: input.shift,
    });
    if (taken) event.preventDefault();
  });
}

/**
 * One isolated guest view for a custom tab (docs/CUSTOM_TABS.md §5.1): its own
 * process, partition and origin, a preload that only forwards the port, and no
 * way out — no popups, no foreign navigation, no WebRTC leaking local IPs.
 */
export function createPluginTabGuest(
  options: PluginTabGuestOptions,
  env: PluginTabGuestEnv,
): PluginTabGuest {
  const { pluginId, hooks } = options;
  env.prepareSession(pluginId);
  const view = new WebContentsView({
    webPreferences: pluginTabWebPreferences(pluginId, env.preloadPath),
  });
  const wc = view.webContents;
  let live = true;
  const isLive = (): boolean => live;
  view.setBackgroundColor(options.background);
  wc.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  installNavigationGuards(wc, pluginId);
  installShortcutRelay(wc, hooks);
  const fail = installLoadEvents(wc, hooks, isLive);
  wc.on("render-process-gone", (_event, details) => {
    if (live) hooks.crashed(details.reason);
  });
  wc.loadURL(pluginTabEntryUrl(pluginId)).catch((error: unknown) => {
    // A superseded first load (reload / close mid-flight) is not a failure.
    if (isAbortedLoad(error)) return;
    fail(error instanceof Error ? error.message : String(error));
  });
  return {
    view,
    webContents: wc,
    destroy: () => {
      if (!live) return;
      live = false;
      if (!wc.isDestroyed()) wc.close();
    },
  };
}
