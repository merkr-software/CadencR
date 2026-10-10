import { isSafeExternalUrl, isUserOpenableUrl } from "@/lib/safe-url";
import type { CadencrBrowserBridge, DesktopTheme } from "./desktop-bridge-types";

export type {
  BrowserBounds,
  BrowserBookmark,
  BrowserAgentAccess,
  BrowserCommentBadgeClick,
  BrowserConsoleEntry,
  BrowserDownload,
  BrowserDownloadSnapshot,
  BrowserDownloadState,
  BrowserElementContext,
  BrowserFindRequest,
  BrowserFindResult,
  BrowserGuestShortcutBindings,
  BrowserHistoryEntry,
  BrowserLibraryChange,
  BrowserOmniboxQueryResult,
  BrowserNetworkEntry,
  BrowserProfileMetadata,
  BrowserPopupRequest,
  BrowserSiteInfo,
  BrowserSitePermission,
  BrowserSitePermissionDecision,
  BrowserSitePermissionRequest,
  BrowserShortcut,
  BrowserStateSnapshot,
  BrowserTabMetadata,
} from "@/shared/browser-types";
export type {
  BrowserResponsiveColorScheme,
  BrowserResponsivePreset,
  BrowserResponsiveRequest,
  BrowserResponsiveState,
} from "@/shared/browser-responsive";
export type {
  CadencrBrowserBridge,
  CadencrDesktopBridge,
  DesktopTheme,
  FileDropItem,
  FileDropPayload,
  NotificationClickPayload,
  NotificationFallbackPayload,
  NotifyBridgeOptions,
  NotifyMode,
  RendererErrorReportPayload,
  RouteType,
  RuntimeConfig,
  UpdateEvent,
} from "./desktop-bridge-types";

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
  suppressNextNativeContextMenu: () => undefined,
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
  openExternalLink: (url: string) => {
    if (typeof window === "undefined") return Promise.resolve();
    if (!isUserOpenableUrl(url)) {
      return Promise.reject(
        new Error("Only http:// and https:// links without credentials can be opened."),
      );
    }
    window.open(url, "_blank", "noopener,noreferrer");
    return Promise.resolve();
  },
  // No native context menu outside the desktop shell, so hover context is a
  // no-op and the menu never fires.
  setLinkHoverContext: () => Promise.resolve(),
  onOpenLinkFromMenu: () => () => undefined,
  pickDirectory: () => unavailable("pickDirectory"),
  pickImageFile: () => unavailable("pickImageFile"),
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
  closeBrowserTabsForScope: () => unavailable("closeBrowserTabsForScope"),
  duplicateBrowserTab: () => unavailable("duplicateBrowserTab"),
  setBrowserTabPinned: () => unavailable("setBrowserTabPinned"),
  reorderBrowserTab: () => unavailable("reorderBrowserTab"),
  closeOtherBrowserTabs: () => unavailable("closeOtherBrowserTabs"),
  reopenLastClosedBrowserTab: () => unavailable("reopenLastClosedBrowserTab"),
  listBrowserDownloads: () => unavailable("listBrowserDownloads"),
  listBrowserDownloadCountsByScope: () => unavailable("listBrowserDownloadCountsByScope"),
  pauseBrowserDownload: () => unavailable("pauseBrowserDownload"),
  resumeBrowserDownload: () => unavailable("resumeBrowserDownload"),
  cancelBrowserDownload: () => unavailable("cancelBrowserDownload"),
  revealBrowserDownload: () => unavailable("revealBrowserDownload"),
  clearBrowserDownloads: () => unavailable("clearBrowserDownloads"),
  listBlockedBrowserPopups: () => unavailable("listBlockedBrowserPopups"),
  allowBrowserPopupOnce: () => unavailable("allowBrowserPopupOnce"),
  openBrowserPopupExternally: () => unavailable("openBrowserPopupExternally"),
  dismissBrowserPopup: () => unavailable("dismissBrowserPopup"),
  setBrowserBounds: () => unavailable("setBrowserBounds"),
  // No native browser view exists in a remote/browser tab, so suppression is a
  // no-op (resolve) rather than an error — dialogs never call it expecting work.
  setBrowserSuppressed: () => Promise.resolve(),
  listBrowserProfiles: () => unavailable("listBrowserProfiles"),
  clearBrowserStorage: () => unavailable("clearBrowserStorage"),
  createBrowserProfile: () => unavailable("createBrowserProfile"),
  duplicateBrowserProfile: () => unavailable("duplicateBrowserProfile"),
  deleteBrowserProfile: () => unavailable("deleteBrowserProfile"),
  getBrowserSiteInfo: () => unavailable("getBrowserSiteInfo"),
  setBrowserSitePermission: () => unavailable("setBrowserSitePermission"),
  clearBrowserSiteData: () => unavailable("clearBrowserSiteData"),
  setBrowserAgentSharing: () => unavailable("setBrowserAgentSharing"),
  resolveBrowserPermissionRequest: () => unavailable("resolveBrowserPermissionRequest"),
  browserBack: () => unavailable("browserBack"),
  browserForward: () => unavailable("browserForward"),
  browserReload: () => unavailable("browserReload"),
  browserStop: () => unavailable("browserStop"),
  browserZoomIn: () => unavailable("browserZoomIn"),
  browserZoomOut: () => unavailable("browserZoomOut"),
  browserZoomReset: () => unavailable("browserZoomReset"),
  findInBrowserTab: () => unavailable("findInBrowserTab"),
  stopFindingInBrowserTab: () => unavailable("stopFindingInBrowserTab"),
  setBrowserGuestShortcuts: () => unavailable("setBrowserGuestShortcuts"),
  queryBrowserOmnibox: () => unavailable("queryBrowserOmnibox"),
  getBrowserBookmark: () => unavailable("getBrowserBookmark"),
  removeBrowserHistoryEntry: () => unavailable("removeBrowserHistoryEntry"),
  clearBrowserHistory: () => unavailable("clearBrowserHistory"),
  setBrowserBookmark: () => unavailable("setBrowserBookmark"),
  toggleBrowserDevTools: () => unavailable("toggleBrowserDevTools"),
  setBrowserResponsive: () => unavailable("setBrowserResponsive"),
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
  onBrowserAgentActivity: () => () => undefined,
  onBrowserShortcut: () => () => undefined,
  onBrowserFindResult: () => () => undefined,
  onBrowserLibraryChanged: () => () => undefined,
  onBrowserCommentBadgeClick: () => () => undefined,
  onBrowserPermissionRequest: () => () => undefined,
  onBrowserPermissionRequestCancelled: () => () => undefined,
  onBrowserPopupRequestsChanged: () => () => undefined,
  onBrowserDownloadsChanged: () => () => undefined,
  onBrowserDownloadCounts: () => () => undefined,
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
