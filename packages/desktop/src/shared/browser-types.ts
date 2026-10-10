import type { BrowserResponsiveState } from "./browser-responsive";

export interface BrowserProfileMetadata {
  id: string;
  label: string;
  mode: "fresh" | "feature" | "persistent";
}

export const BROWSER_SITE_PERMISSIONS = ["camera", "microphone", "location", "clipboard"] as const;

export type BrowserSitePermission = (typeof BROWSER_SITE_PERMISSIONS)[number];

export const BROWSER_SITE_PERMISSION_DECISIONS = ["ask", "allow", "deny"] as const;

export type BrowserSitePermissionDecision = (typeof BROWSER_SITE_PERMISSION_DECISIONS)[number];

/** Maximum inline favicon URL accepted across the main/renderer boundary. */
export const MAX_BROWSER_FAVICON_DATA_URL_LENGTH = 256 * 1024;
export const MAX_BROWSER_FIND_QUERY_LENGTH = 10_000;
/** Main/renderer contract for persisted Browser library lookups. */
export const MAX_BROWSER_LIBRARY_QUERY_LENGTH = 256;
export const MAX_BROWSER_LIBRARY_URL_LENGTH = 2048;

/** Whether an agent may inspect or automate this specific tab. */
export type BrowserAgentAccess = "user" | "shared" | "agent";

export interface BrowserSiteInfo {
  tabId: string;
  /** The live main-frame origin. `null` for pages such as `about:blank`. */
  origin: string | null;
  secure: boolean;
  profile: BrowserProfileMetadata;
  privacy: "normal" | "private" | "feature";
  permissions: Record<BrowserSitePermission, BrowserSitePermissionDecision>;
  agentAccess: BrowserAgentAccess;
}

/** A website permission prompt emitted by the main process for one live tab. */
export interface BrowserSitePermissionRequest {
  requestId: string;
  tabId: string;
  scopeId: number | null;
  origin: string;
  topOrigin: string;
  permissions: BrowserSitePermission[];
}

export interface BrowserTabMetadata {
  id: string;
  title: string;
  url: string;
  faviconUrl?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  sessionProfileId: string;
  isActive: boolean;
  devToolsOpen: boolean;
  /** Pinned tabs stay grouped first and survive bulk "close others" actions. */
  pinned: boolean;
  /** Restored metadata with no live WebContents yet; activating it materializes the tab. */
  suspended: boolean;
  /** Native sign-in / POST child whose request cannot be safely replayed after restart. */
  temporary?: boolean;
  /** Authoritative zoom reported by the guest WebContents. */
  zoomPercent: number;
  /** Per-tab Chromium viewport emulation. The same WebContents remains alive. */
  responsive: BrowserResponsiveState;
  /**
   * The feature-layout scope that owns this tab. Tabs are isolated per scope so
   * a tab opened in one feature's Browser never leaks into another's. Agent/MCP
   * tabs are scoped too: the browser MCP is pinned to its feature, so they show
   * in that feature's tab strip. `null` (scopeless) only remains for automation
   * calls that carry no feature.
   */
  scopeId: number | null;
}

export interface BrowserPopupRequest {
  id: string;
  tabId: string;
  scopeId: number | null;
  /** Sanitized destination origin; the target path and POST body stay main-process-only. */
  origin: string;
  hasPostData: boolean;
  externalAvailable: boolean;
  status: "blocked" | "allowed-once";
  allowExpiresAt?: string;
}

export type BrowserDownloadState =
  | "progressing"
  | "paused"
  | "interrupted"
  | "completed"
  | "cancelled"
  | "failed";

/** Sanitized, renderer-safe view of a native download owned by Browser chrome. */
export interface BrowserDownload {
  id: string;
  tabId: string;
  scopeId: number;
  filename: string;
  destination: string;
  state: BrowserDownloadState;
  receivedBytes: number;
  totalBytes: number | null;
  bytesPerSecond: number;
  percent: number | null;
  canPause: boolean;
  canResume: boolean;
  canCancel: boolean;
  private: boolean;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

/** Authoritative, scope-isolated snapshot; download history is never persisted. */
export interface BrowserDownloadSnapshot {
  scopeId: number;
  downloads: BrowserDownload[];
  activeCount: number;
  aggregatePercent: number | null;
}

export interface BrowserFindRequest {
  /** Renderer-generated correlation token, established before IPC starts. */
  requestToken: string;
  query: string;
  forward: boolean;
  /** `true` starts a new session; `false` advances the current session. */
  findNext: boolean;
}

export interface BrowserFindResult {
  tabId: string;
  requestToken: string;
  activeMatchOrdinal: number;
  matches: number;
  finalUpdate: boolean;
}

/** Registry tokens forwarded to the main process for focused-guest matching. */
export interface BrowserShortcutBinding {
  keys: string[];
  altKeys?: string[];
}

export interface BrowserGuestShortcutBindings {
  find: BrowserShortcutBinding;
  downloads: BrowserShortcutBinding;
  responsive: BrowserShortcutBinding;
  devtools: BrowserShortcutBinding;
  zoomReset: BrowserShortcutBinding;
}

export interface BrowserOpenUrlOptions {
  tabId?: string;
  newTab?: boolean;
  scopeId?: number | null;
}

export interface BrowserHistoryEntry {
  id: string;
  url: string;
  title: string;
  visitedAt: string;
}

export interface BrowserBookmark {
  id: string;
  url: string;
  title: string;
  createdAt: string;
}

export interface BrowserOmniboxQueryResult {
  history: BrowserHistoryEntry[];
  bookmarks: BrowserBookmark[];
  historyCount: number;
  bookmarkCount: number;
}

/** Narrow invalidation signal; persisted library contents remain main-process-owned. */
export type BrowserLibraryChange = { kind: "history" } | { kind: "bookmark"; url: string };

export interface BrowserConsoleEntry {
  id: string;
  tabId: string;
  level: string;
  message: string;
  sourceUrl: string;
  lineNumber: number;
  timestamp: string;
}

export interface BrowserNetworkEntry {
  id: string;
  tabId: string;
  method: string;
  url: string;
  status?: number;
  requestHeaders: Record<string, string | string[] | undefined>;
  responseHeaders: Record<string, string | string[] | undefined>;
  resourceType?: string;
  timestamp: string;
  failureReason?: string;
}

/**
 * Pushed on `browser:agent-activity` after an agent's browser MCP tool call
 * succeeds, so the renderer can follow the agent (auto layout, activity dot).
 */
export interface BrowserAgentActivity {
  /** The calling feature (the MCP's pinned feature id). */
  scopeId: number;
  /**
   * `open`: the agent opened a page, which earns it a reveal. `interact`: it
   * clicked, typed or inspected a page it already had open.
   */
  action: "open" | "interact";
}

export interface BrowserStateSnapshot {
  /**
   * The scope this snapshot describes, or `null`/`undefined` for the unscoped
   * (all-tabs) view used by agent/MCP automation. UI consumers ignore snapshots
   * whose `scopeId` doesn't match their own feature scope.
   */
  scopeId?: number | null;
  tabs: BrowserTabMetadata[];
  activeTabId: string | null;
  consoleEntries: BrowserConsoleEntry[];
  networkEntries: BrowserNetworkEntry[];
  /**
   * Origins the user has previously navigated to (e.g. `http://localhost:1420`,
   * `https://example.com`), ranked most-pertinent first. Feeds the address-bar
   * autocomplete so previously opened sites can be reopened with a few keys.
   */
  knownOrigins: string[];
  error: string | null;
}

/**
 * Chords forwarded from a focused guest page (a native `WebContentsView`
 * swallows keydown before the renderer can see it, so the main process
 * intercepts these via `before-input-event` and relays them). Covers both
 * browser-chrome chords and the feature-pane switches (⌘⇧A/T/G/E/B), which
 * must still work while the guest page holds keyboard focus.
 */
export type BrowserShortcut =
  | "new-tab"
  | "close-tab"
  | "reopen-tab"
  | "prev-tab"
  | "next-tab"
  | "focus-url"
  | "find"
  | "add-comment"
  | "downloads"
  | "responsive"
  | "devtools"
  | "reload"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset"
  | "pane-agent"
  | "pane-terminal"
  | "pane-git"
  | "pane-editor"
  | "pane-browser";

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A user click on an on-page comment badge, relayed from the guest page so the
 * renderer can reopen that comment's composer. `box` is the anchored element's
 * current viewport rect (used to position the form), or null if it's gone.
 */
export interface BrowserCommentBadgeClick {
  tabId: string;
  anchorId: string;
  box: BrowserBounds | null;
}

export interface BrowserElementContext {
  tabId: string;
  url: string;
  title: string;
  capturedAt: string;
  screenshotPngBase64: string;
  element: {
    selectorCandidates: string[];
    tagName: string;
    id?: string;
    className?: string;
    textPreview?: string;
    attributes: Record<string, string>;
    boundingBox: { x: number; y: number; width: number; height: number };
    computedStyles: Record<string, string>;
    accessibility?: { role?: string; name?: string };
  };
  diagnostics: {
    consoleErrors: BrowserConsoleEntry[];
    failedNetworkRequests: BrowserNetworkEntry[];
  };
}
