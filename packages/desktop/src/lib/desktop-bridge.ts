import { isSafeExternalUrl } from "@/lib/safe-url";
import type {
  BrowserBounds,
  BrowserCommentBadgeClick,
  BrowserConsoleEntry,
  BrowserElementContext,
  BrowserNetworkEntry,
  BrowserProfileMetadata,
  BrowserShortcut,
  BrowserStateSnapshot,
  BrowserTabMetadata,
} from "@/shared/browser-types";

export type {
  BrowserBounds,
  BrowserCommentBadgeClick,
  BrowserConsoleEntry,
  BrowserElementContext,
  BrowserNetworkEntry,
  BrowserProfileMetadata,
  BrowserShortcut,
  BrowserStateSnapshot,
  BrowserTabMetadata,
} from "@/shared/browser-types";

export interface RuntimeConfig {
  baseUrl: string;
  authToken: string | null;
}

export type RouteType = "session";
export type DesktopTheme = "light" | "dark";

export interface NotificationClickPayload {
  feature_id: number;
  project_id: number;
  route_type: RouteType;
}

export interface NotificationFallbackPayload {
  title: string;
  body: string;
  click: NotificationClickPayload | null;
}

/**
 * Where an agent-finished notification should be rendered. `"off"` is
 * resolved in the renderer (we just skip the bridge call entirely), so
 * the bridge only ever sees these two modes.
 */
export type NotifyMode = "native" | "in_app";

export interface NotifyBridgeOptions {
  title: string;
  body: string;
  featureId: number;
  projectId: number;
  routeType: RouteType;
  mode: NotifyMode;
}

export interface FileDropItem {
  handle: string;
  name: string;
}

export interface FileDropPayload {
  type: "enter" | "leave" | "drop" | "error";
  files: FileDropItem[];
  targetPromptId?: string;
  message?: string;
}

export type UpdateEvent =
  | { kind: "checking" }
  | { kind: "available"; version: string }
  | {
      /** Markdown body for `version`, fetched from GitHub. `null` on miss/failure. */
      kind: "changelog";
      version: string;
      markdown: string | null;
    }
  | { kind: "not-available"; version: string }
  | { kind: "error"; message: string }
  | { kind: "download-progress"; percent: number; bytesPerSecond: number }
  | { kind: "downloaded"; version: string };

export interface RendererErrorReportPayload {
  source: "error" | "unhandledrejection" | "react-boundary";
  message: string;
  stack?: string | null;
  componentStack?: string | null;
  url?: string | null;
  line?: number | null;
  column?: number | null;
}

export interface CadencrDesktopBridge {
  isElectron: boolean;
  runtimeConfig: () => Promise<RuntimeConfig>;
  readFileBase64: (handle: string) => Promise<string>;
  onFileDrop: (cb: (payload: FileDropPayload) => void) => () => void;
  revealInFinder: (path: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  pickDirectory: () => Promise<string | null>;
  /**
   * Prompt the user with the native "Save As" dialog. Resolves to the chosen
   * absolute path or `null` if the dialog was canceled.
   */
  showSaveDialog: (opts: { defaultPath: string; title?: string }) => Promise<string | null>;
  notifyPermission: () => Promise<boolean>;
  notify: (opts: NotifyBridgeOptions) => Promise<void>;
  notifyTest: () => Promise<void>;
  onNotificationClicked: (cb: (payload: NotificationClickPayload) => void) => () => void;
  onNotificationFailed: (cb: (payload: { reason: string }) => void) => () => void;
  onNotificationFallback: (cb: (payload: NotificationFallbackPayload) => void) => () => void;
  onCloseRequested: (cb: () => void) => () => void;
  confirmClose: () => Promise<void>;
  requestQuit: () => Promise<void>;
  reportRendererError?: (payload: RendererErrorReportPayload) => Promise<void>;
  setZoom: (factor: number) => Promise<void>;
  currentTheme: () => Promise<DesktopTheme>;
  onThemeChange: (cb: (appearance: DesktopTheme) => void) => () => void;
  /**
   * Tell the main process whether any agent turn is currently active. Main
   * uses this to ref-count `powerSaveBlocker('prevent-app-suspension')` so
   * the OS keeps the system awake while agents stream and lets it sleep
   * normally when they don't (per `feature-sleep-aware-agent-reliability`).
   */
  setBusy: (busy: boolean) => Promise<void>;
  /**
   * Request (or release) a macOS-friendly idle-system-sleep block for remote
   * hosting. Held independently of `setBusy` so neither caller releases the
   * other's assertion. Uses `prevent-app-suspension`, so the display may still
   * sleep/lock; only idle system sleep is blocked. No-op off macOS / in a
   * browser. See `feature/macos-remote-ux-sleep-prevention`.
   */
  setRemoteHostAwake: (enabled: boolean) => Promise<void>;
  /** Fired just before the OS suspends. Cleanup is up to the renderer. */
  onPowerSuspend: (cb: () => void) => () => void;
  /** Fired right after wake-from-suspend. */
  onPowerResume: (cb: () => void) => () => void;

  /** Ask the main process to check for an update right now. */
  checkForUpdates: () => Promise<void>;
  /** Quit and install a downloaded update. */
  installUpdate: () => Promise<void>;
  /**
   * Fetch the markdown release notes for a given version from GitHub.
   * Returns `null` when the release isn't published or the request fails.
   */
  fetchChangelog: (version: string) => Promise<string | null>;
  /** Subscribe to all auto-updater lifecycle events. */
  onUpdateEvent: (cb: (event: UpdateEvent) => void) => () => void;
}

export interface CadencrBrowserBridge extends CadencrDesktopBridge {
  reportRendererError: (payload: RendererErrorReportPayload) => Promise<void>;
  createBrowserTab: (
    url?: string,
    profileId?: string,
    scopeId?: number | null,
  ) => Promise<BrowserTabMetadata>;
  listBrowserTabs: (scopeId?: number | null) => Promise<BrowserStateSnapshot>;
  listBrowserTabCountsByScope: () => Promise<Record<number, number>>;
  navigateBrowserTab: (tabId: string, url: string) => Promise<BrowserTabMetadata>;
  activateBrowserTab: (tabId: string) => Promise<BrowserTabMetadata>;
  closeBrowserTab: (tabId: string) => Promise<BrowserStateSnapshot>;
  setBrowserBounds: (
    bounds: BrowserBounds,
    scopeId?: number | null,
  ) => Promise<BrowserStateSnapshot>;
  setBrowserSuppressed: (value: boolean) => Promise<void>;
  listBrowserProfiles: () => Promise<BrowserProfileMetadata[]>;
  clearBrowserStorage: (profileId: string) => Promise<void>;
  createBrowserProfile: (profileId: string) => Promise<BrowserProfileMetadata>;
  duplicateBrowserProfile: (sourceId: string, newId: string) => Promise<BrowserProfileMetadata>;
  deleteBrowserProfile: (profileId: string) => Promise<void>;
  browserBack: (tabId: string) => Promise<void>;
  browserForward: (tabId: string) => Promise<void>;
  browserReload: (tabId: string) => Promise<void>;
  browserStop: (tabId: string) => Promise<void>;
  browserZoomIn: (tabId: string) => Promise<void>;
  browserZoomOut: (tabId: string) => Promise<void>;
  toggleBrowserDevTools: (tabId: string) => Promise<BrowserTabMetadata>;
  getBrowserConsole: () => Promise<BrowserConsoleEntry[]>;
  getBrowserNetwork: () => Promise<BrowserNetworkEntry[]>;
  getBrowserSnapshot: (tabId: string) => Promise<unknown>;
  getBrowserScreenshot: (tabId: string) => Promise<string>;
  browserClick: (tabId: string, x: number, y: number) => Promise<void>;
  browserType: (tabId: string, text: string) => Promise<void>;
  browserKeypress: (tabId: string, keyCode: string) => Promise<void>;
  selectBrowserElementContext: (tabId: string, anchorId: string) => Promise<BrowserElementContext>;
  /** Remove the on-page numbered badge anchored to `anchorId`. */
  removeBrowserCommentBadge: (tabId: string, anchorId: string) => Promise<void>;
  /** Remove every on-page comment badge from the tab. */
  clearBrowserCommentBadges: (tabId: string) => Promise<void>;
  onBrowserState: (cb: (state: BrowserStateSnapshot) => void) => () => void;
  onBrowserTabCounts: (cb: (counts: Record<number, number>) => void) => () => void;
  onBrowserShortcut: (cb: (shortcut: BrowserShortcut) => void) => () => void;
  /** A user click on an on-page comment badge, to reopen that comment's composer. */
  onBrowserCommentBadgeClick: (cb: (event: BrowserCommentBadgeClick) => void) => () => void;
}

declare global {
  interface Window {
    cadencr?: Partial<CadencrBrowserBridge>;
  }
}

let bridgeOverride: Partial<CadencrBrowserBridge> | null = null;

function browserTheme(): DesktopTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function unavailable(name: string): Promise<never> {
  return Promise.reject(new Error(`${name} is only available in the desktop shell.`));
}

const browserBridge: CadencrBrowserBridge = {
  isElectron: false,
  runtimeConfig: () => unavailable("runtimeConfig"),
  readFileBase64: () => unavailable("readFileBase64"),
  onFileDrop: () => () => undefined,
  revealInFinder: () => unavailable("revealInFinder"),
  // Opening a URL has a universal browser equivalent (keeps "view compare URL",
  // changelog links, etc. working in a remote tab), but it must enforce the same
  // policy the Electron shell does — reject anything that isn't a credential-free
  // https URL to a non-loopback host — so callers' error handling stays uniform.
  openExternal: (url: string) => {
    if (typeof window === "undefined") return Promise.resolve();
    if (!isSafeExternalUrl(url)) {
      return Promise.reject(
        new Error("Only https:// URLs without credentials or loopback hosts can be opened."),
      );
    }
    window.open(url, "_blank", "noopener,noreferrer");
    return Promise.resolve();
  },
  pickDirectory: () => unavailable("pickDirectory"),
  showSaveDialog: () => unavailable("showSaveDialog"),
  notifyPermission: () => Promise.resolve(false),
  notify: () => Promise.resolve(),
  notifyTest: () => unavailable("notifyTest"),
  onNotificationClicked: () => () => undefined,
  onNotificationFailed: () => () => undefined,
  onNotificationFallback: () => () => undefined,
  onCloseRequested: () => () => undefined,
  confirmClose: () => Promise.resolve(),
  requestQuit: () => Promise.resolve(),
  reportRendererError: () => Promise.resolve(),
  setZoom: () => Promise.resolve(),
  currentTheme: () => Promise.resolve(browserTheme()),
  onThemeChange: () => () => undefined,
  setBusy: () => Promise.resolve(),
  setRemoteHostAwake: () => Promise.resolve(),
  onPowerSuspend: () => () => undefined,
  onPowerResume: () => () => undefined,

  createBrowserTab: () => unavailable("createBrowserTab"),
  listBrowserTabs: () => unavailable("listBrowserTabs"),
  listBrowserTabCountsByScope: () => Promise.resolve({}),
  navigateBrowserTab: () => unavailable("navigateBrowserTab"),
  activateBrowserTab: () => unavailable("activateBrowserTab"),
  closeBrowserTab: () => unavailable("closeBrowserTab"),
  setBrowserBounds: () => unavailable("setBrowserBounds"),
  // No native browser view exists in a remote/browser tab, so suppression is a
  // no-op (resolve) rather than an error — dialogs never call it expecting work.
  setBrowserSuppressed: () => Promise.resolve(),
  listBrowserProfiles: () => unavailable("listBrowserProfiles"),
  clearBrowserStorage: () => unavailable("clearBrowserStorage"),
  createBrowserProfile: () => unavailable("createBrowserProfile"),
  duplicateBrowserProfile: () => unavailable("duplicateBrowserProfile"),
  deleteBrowserProfile: () => unavailable("deleteBrowserProfile"),
  browserBack: () => unavailable("browserBack"),
  browserForward: () => unavailable("browserForward"),
  browserReload: () => unavailable("browserReload"),
  browserStop: () => unavailable("browserStop"),
  browserZoomIn: () => unavailable("browserZoomIn"),
  browserZoomOut: () => unavailable("browserZoomOut"),
  toggleBrowserDevTools: () => unavailable("toggleBrowserDevTools"),
  getBrowserConsole: () => unavailable("getBrowserConsole"),
  getBrowserNetwork: () => unavailable("getBrowserNetwork"),
  getBrowserSnapshot: () => unavailable("getBrowserSnapshot"),
  getBrowserScreenshot: () => unavailable("getBrowserScreenshot"),
  browserClick: () => unavailable("browserClick"),
  browserType: () => unavailable("browserType"),
  browserKeypress: () => unavailable("browserKeypress"),
  selectBrowserElementContext: () => unavailable("selectBrowserElementContext"),
  // No native browser view in a remote/browser tab, so badge ops are no-ops.
  removeBrowserCommentBadge: () => Promise.resolve(),
  clearBrowserCommentBadges: () => Promise.resolve(),
  onBrowserState: () => () => undefined,
  onBrowserTabCounts: () => () => undefined,
  onBrowserShortcut: () => () => undefined,
  onBrowserCommentBadgeClick: () => () => undefined,
  checkForUpdates: () => unavailable("checkForUpdates"),
  installUpdate: () => unavailable("installUpdate"),
  fetchChangelog: () => Promise.resolve(null),
  onUpdateEvent: () => () => undefined,
};

function resolveBridgeValue(prop: keyof CadencrBrowserBridge): { owner: object; value: unknown } {
  if (bridgeOverride && prop in bridgeOverride) {
    return { owner: bridgeOverride, value: bridgeOverride[prop] };
  }
  if (typeof window !== "undefined" && window.cadencr && prop in window.cadencr) {
    return { owner: window.cadencr, value: window.cadencr[prop] };
  }
  return { owner: browserBridge, value: browserBridge[prop] };
}

export const desktopBridge: CadencrBrowserBridge = new Proxy({} as CadencrBrowserBridge, {
  get(_target: CadencrBrowserBridge, prop: string | symbol): unknown {
    const { owner, value } = resolveBridgeValue(prop as keyof CadencrBrowserBridge);
    return typeof value === "function" ? value.bind(owner) : value;
  },
});

/**
 * True when running inside the Electron desktop shell (preload bridge present).
 * Use to gate native-only affordances — folder pickers, "reveal in Finder",
 * save dialogs, native notifications — that have no browser equivalent, so a
 * remote-browser session doesn't surface buttons that can only reject.
 */
export function isDesktopShell(): boolean {
  return desktopBridge.isElectron;
}

export function setDesktopBridgeOverrideForTests(bridge: Partial<CadencrBrowserBridge>): void {
  bridgeOverride = bridge;
}

export function clearDesktopBridgeOverrideForTests(): void {
  bridgeOverride = null;
}
