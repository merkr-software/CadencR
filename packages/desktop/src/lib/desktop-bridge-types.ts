import type { DiagnosticContext } from "@/shared/renderer-diagnostics";
import type {
  NotchCapabilities,
  NotchConfig,
  NotchFeatureRef,
  NotchNotification,
  NotchSnapshot,
} from "@/shared/notch";
import type { ChangelogImageBytes } from "@/shared/changelog-image";
import type { RendererErrorReportPayload } from "@/shared/renderer-error";
import type { LinkHoverContext, LinkMenuOpenPayload } from "@/lib/link-routing";
import type {
  BrowserBounds,
  BrowserBookmark,
  BrowserCommentBadgeClick,
  BrowserConsoleEntry,
  BrowserDownloadSnapshot,
  BrowserElementContext,
  BrowserFindRequest,
  BrowserFindResult,
  BrowserGuestShortcutBindings,
  BrowserLibraryChange,
  BrowserNetworkEntry,
  BrowserOmniboxQueryResult,
  BrowserPopupRequest,
  BrowserProfileMetadata,
  BrowserShortcut,
  BrowserSiteInfo,
  BrowserSitePermission,
  BrowserSitePermissionDecision,
  BrowserSitePermissionRequest,
  BrowserStateSnapshot,
  BrowserTabMetadata,
  BrowserAgentActivity,
} from "@/shared/browser-types";
import type { BrowserResponsiveRequest } from "@/shared/browser-responsive";
import type { PluginTabsBridge } from "@/shared/plugin-tab-host";

export interface RuntimeConfig {
  baseUrl: string;
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
  | { kind: "downloaded"; version: string }
  | {
      /**
       * In-app updates are unavailable because this Linux build is not an
       * official AppImage, DEB, or RPM package. The renderer should render
       * `message` instead of offering a non-working update action.
       */
      kind: "unsupported";
      reason: "unsupported-install";
      message: string;
    };

export type { RendererErrorReportPayload } from "@/shared/renderer-error";
import type { AppCloseChoice, AppCloseRequest } from "@/shared/app-close";

export interface CadencrDesktopBridge {
  isElectron: boolean;
  usesCustomWindowControls?: boolean;
  runtimeConfig: () => Promise<RuntimeConfig>;
  readFileBase64: (handle: string) => Promise<string>;
  suppressNextNativeContextMenu?: () => void;
  onFileDrop: (cb: (payload: FileDropPayload) => void) => () => void;
  revealInFinder: (path: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  /** User-initiated open in the default browser, including local HTTP and documents. */
  openExternalLink: (url: string) => Promise<void>;
  setLinkHoverContext: (context: LinkHoverContext | null) => Promise<void>;
  onOpenLinkFromMenu: (cb: (payload: LinkMenuOpenPayload) => void) => () => void;
  pickDirectory: () => Promise<string | null>;
  pickImageFile: () => Promise<string | null>;
  showSaveDialog: (opts: { defaultPath: string; title?: string }) => Promise<string | null>;
  notifyPermission: () => Promise<boolean>;
  notify: (opts: NotifyBridgeOptions) => Promise<void>;
  notifyTest: () => Promise<void>;
  onNotificationClicked: (cb: (payload: NotificationClickPayload) => void) => () => void;
  onNotificationFailed: (cb: (payload: { reason: string }) => void) => () => void;
  onNotificationFallback: (cb: (payload: NotificationFallbackPayload) => void) => () => void;
  onCloseRequested: (cb: (request: AppCloseRequest) => void) => () => void;
  confirmClose: (choice?: AppCloseChoice) => Promise<void>;
  requestQuit: () => Promise<void>;
  windowMinimize?: () => Promise<void>;
  windowToggleMaximize?: () => Promise<void>;
  windowClose?: () => Promise<void>;
  exportRendererDiagnostics?: (context: DiagnosticContext) => Promise<{ canceled: boolean }>;
  reportRendererError?: (payload: RendererErrorReportPayload) => Promise<void>;
  setZoom: (factor: number) => Promise<void>;
  /** Centers the macOS traffic lights on a band `center` CSS px from the top; null restores them. */
  setTrafficLightsCenter?: (center: number | null) => Promise<void>;
  currentTheme: () => Promise<DesktopTheme>;
  onThemeChange: (cb: (appearance: DesktopTheme) => void) => () => void;
  setBusy: (busy: boolean) => Promise<void>;
  setRemoteHostAwake: (enabled: boolean) => Promise<void>;
  onPowerSuspend: (cb: () => void) => () => void;
  onPowerResume: (cb: () => void) => () => void;
  /**
   * Whether the app window has focus, also while a guest view inside it (a
   * custom tab, a browser pane) holds it. Desktop only: in a browser the
   * document's own focus is the window's.
   */
  isWindowFocused?: () => Promise<boolean>;
  onWindowFocusChange?: (cb: (focused: boolean) => void) => () => void;
  checkForUpdates: () => Promise<void>;
  installUpdate: () => Promise<void>;
  fetchChangelog: (version: string) => Promise<string | null>;
  /** Bytes of an image committed to Cadencr's repo and referenced by release notes. */
  fetchChangelogImage: (src: string) => Promise<ChangelogImageBytes>;
  onUpdateEvent: (cb: (event: UpdateEvent) => void) => () => void;
}

export interface CadencrBrowserBridge extends CadencrDesktopBridge {
  exportRendererDiagnostics: (context: DiagnosticContext) => Promise<{ canceled: boolean }>;
  reportRendererError: (payload: RendererErrorReportPayload) => Promise<void>;
  setTrafficLightsCenter: (center: number | null) => Promise<void>;
  // The macOS notch island; the browser fallback resolves them as unsupported.
  notchCapabilities: () => Promise<NotchCapabilities>;
  notchConfigure: (config: NotchConfig) => Promise<void>;
  notchPushSnapshot: (snapshot: NotchSnapshot) => Promise<void>;
  notchNotify: (notification: NotchNotification) => Promise<void>;
  onNotchDismissed: (cb: (ref: NotchFeatureRef) => void) => () => void;
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
  closeBrowserTabsForScope: (scopeId: number) => Promise<BrowserStateSnapshot>;
  duplicateBrowserTab: (tabId: string) => Promise<BrowserTabMetadata>;
  setBrowserTabPinned: (tabId: string, pinned: boolean) => Promise<BrowserStateSnapshot>;
  reorderBrowserTab: (tabId: string, targetIndex: number) => Promise<BrowserStateSnapshot>;
  closeOtherBrowserTabs: (tabId: string) => Promise<BrowserStateSnapshot>;
  reopenLastClosedBrowserTab: (scopeId: number) => Promise<BrowserTabMetadata | null>;
  listBrowserDownloads: (scopeId: number) => Promise<BrowserDownloadSnapshot>;
  listBrowserDownloadCountsByScope: () => Promise<Record<number, number>>;
  pauseBrowserDownload: (scopeId: number, id: string) => Promise<BrowserDownloadSnapshot>;
  resumeBrowserDownload: (scopeId: number, id: string) => Promise<BrowserDownloadSnapshot>;
  cancelBrowserDownload: (scopeId: number, id: string) => Promise<BrowserDownloadSnapshot>;
  revealBrowserDownload: (scopeId: number, id: string) => Promise<void>;
  clearBrowserDownloads: (scopeId: number) => Promise<BrowserDownloadSnapshot>;
  listBlockedBrowserPopups: (scopeId: number) => Promise<BrowserPopupRequest[]>;
  allowBrowserPopupOnce: (requestId: string) => Promise<void>;
  openBrowserPopupExternally: (requestId: string) => Promise<void>;
  dismissBrowserPopup: (requestId: string) => Promise<void>;
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
  getBrowserSiteInfo: (tabId: string) => Promise<BrowserSiteInfo>;
  setBrowserSitePermission: (
    tabId: string,
    origin: string,
    permission: BrowserSitePermission,
    decision: BrowserSitePermissionDecision,
  ) => Promise<BrowserSiteInfo>;
  clearBrowserSiteData: (tabId: string, origin: string) => Promise<BrowserSiteInfo>;
  setBrowserAgentSharing: (
    tabId: string,
    origin: string,
    shared: boolean,
  ) => Promise<BrowserSiteInfo>;
  resolveBrowserPermissionRequest: (requestId: string, allowed: boolean) => Promise<void>;
  browserBack: (tabId: string) => Promise<void>;
  browserForward: (tabId: string) => Promise<void>;
  browserReload: (tabId: string) => Promise<void>;
  browserStop: (tabId: string) => Promise<void>;
  browserZoomIn: (tabId: string) => Promise<void>;
  browserZoomOut: (tabId: string) => Promise<void>;
  browserZoomReset: (tabId: string) => Promise<void>;
  findInBrowserTab: (tabId: string, request: BrowserFindRequest) => Promise<void>;
  stopFindingInBrowserTab: (tabId: string, focusPage: boolean) => Promise<void>;
  setBrowserGuestShortcuts: (bindings: BrowserGuestShortcutBindings) => Promise<void>;
  queryBrowserOmnibox: (query: string, limit?: number) => Promise<BrowserOmniboxQueryResult>;
  getBrowserBookmark: (url: string) => Promise<BrowserBookmark | null>;
  removeBrowserHistoryEntry: (id: string) => Promise<void>;
  clearBrowserHistory: () => Promise<void>;
  setBrowserBookmark: (tabId: string, bookmarked: boolean) => Promise<BrowserBookmark | null>;
  toggleBrowserDevTools: (tabId: string) => Promise<BrowserTabMetadata>;
  setBrowserResponsive: (
    tabId: string,
    request: BrowserResponsiveRequest,
  ) => Promise<BrowserTabMetadata>;
  getBrowserConsole: () => Promise<BrowserConsoleEntry[]>;
  getBrowserNetwork: () => Promise<BrowserNetworkEntry[]>;
  getBrowserSnapshot: (tabId: string) => Promise<unknown>;
  getBrowserScreenshot: (tabId: string) => Promise<string>;
  browserClick: (tabId: string, x: number, y: number) => Promise<void>;
  browserType: (tabId: string, text: string) => Promise<void>;
  browserKeypress: (tabId: string, keyCode: string) => Promise<void>;
  selectBrowserElementContext: (tabId: string, anchorId: string) => Promise<BrowserElementContext>;
  removeBrowserCommentBadge: (tabId: string, anchorId: string) => Promise<void>;
  clearBrowserCommentBadges: (tabId: string) => Promise<void>;
  onBrowserState: (cb: (state: BrowserStateSnapshot) => void) => () => void;
  onBrowserTabCounts: (cb: (counts: Record<number, number>) => void) => () => void;
  onBrowserAgentActivity: (cb: (activity: BrowserAgentActivity) => void) => () => void;
  onBrowserShortcut: (cb: (shortcut: BrowserShortcut) => void) => () => void;
  onBrowserFindResult: (cb: (result: BrowserFindResult) => void) => () => void;
  onBrowserLibraryChanged: (cb: (change: BrowserLibraryChange) => void) => () => void;
  onBrowserCommentBadgeClick: (cb: (event: BrowserCommentBadgeClick) => void) => () => void;
  onBrowserPermissionRequest: (cb: (request: BrowserSitePermissionRequest) => void) => () => void;
  onBrowserPermissionRequestCancelled: (cb: (event: { requestId: string }) => void) => () => void;
  onBrowserPopupRequestsChanged: (cb: (event: { scopeId: number }) => void) => () => void;
  onBrowserDownloadsChanged: (cb: (snapshot: BrowserDownloadSnapshot) => void) => () => void;
  onBrowserDownloadCounts: (cb: (counts: Record<number, number>) => void) => () => void;
  /**
   * Native guest views for custom tabs (docs/CUSTOM_TABS.md §5); no-ops off the
   * desktop shell. Each guest load also delivers the renderer's end of that
   * instance's MessageChannel — not through this object (contextBridge can't
   * carry ports) but as a `window` "message" event whose `data` is a
   * `PluginTabPortMessage` (`type === PLUGIN_TAB_PORT_MESSAGE_TYPE`; both live in
   * `@/shared/plugin-tab-host`) with `event.source === window` and the port
   * in `event.ports[0]`.
   */
  pluginTabs: PluginTabsBridge;
}

declare global {
  interface Window {
    cadencr?: Partial<CadencrBrowserBridge>;
  }
}
