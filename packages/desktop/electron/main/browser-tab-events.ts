import type { Input, Result, WebContents, WebContentsView } from "electron";
import { normalizeBrowserOpenUrl } from "./browser-policy";
import { installBrowserFaviconEvents } from "./browser-tab-favicon-events";
import { consoleEntry, originOf, pushBounded, updateTabMetadata } from "./browser-manager-utils";
import { COMMENT_BADGE_CLICK_SENTINEL } from "./browser-comment-overlay-script";
import { invalidateBrowserDocument } from "./browser-document-security";
import { isCadencrBrowserUrl } from "./browser-self-origin-policy";
import type { BrowserProfile } from "./browser-profiles";
import type {
  BrowserAgentAccess,
  BrowserBounds,
  BrowserConsoleEntry,
  BrowserNetworkEntry,
  BrowserShortcut,
  BrowserTabMetadata,
} from "./browser-types";

const MAX_CONSOLE_PER_TAB = 1000;
const DEFAULT_URL = "about:blank";

export interface ManagedTab {
  metadata: BrowserTabMetadata;
  automationAccess: BrowserAgentAccess;
  /** Resolved profile identity; unlike metadata, this includes a fresh session's actual UUID. */
  profile: BrowserProfile;
  view: WebContentsView;
  /** Retained because Electron clears `view.webContents` during `destroyed`. */
  webContents: WebContents;
  devtoolsView: WebContentsView | null;
  devtoolsWebContents: WebContents | null;
  consoleEntries: BrowserConsoleEntry[];
  networkEntries: BrowserNetworkEntry[];
  /** Guest-session work that must settle before a private partition is cleared. */
  pendingSessionTasks: Set<Promise<void>>;
  /** Auth/POST popup requests are not safe to persist, reopen, or add to history. */
  temporary: boolean;
  /** Recent trusted native gesture, kept on the tab so automation can revoke it. */
  popupGestureAt: number | null;
  /** Synthetic input events to exclude from popup gesture accounting. */
  syntheticPopupMouseEvents: number;
  syntheticPopupKeyEvents: number;
  syntheticPopupInputExpiresAt: number;
  /** Source tab for a temporary auth child; used only for focus return on close. */
  openerTabId: string | null;
  /** Releases parent/focus listeners if a temporary child is promoted or destroyed. */
  detachOpenerRelations: (() => void) | null;
  // Origin approved via the permission-gated browser_open_external_url tool. While
  // the tab stays on this origin it is exempt from the localhost-only automation
  // (mutation) gate; navigating elsewhere re-locks it. null = not unlocked.
  externalAutomationOrigin: string | null;
}

// The slice of BrowserManager that tab-event handlers drive. Passed in so the
// event wiring lives here without the manager exposing its internals.
export interface TabEventHost {
  emitState(): void;
  setLastError(message: string | null): void;
  isTabAlive(): boolean;
  tabDestroyed(): void;
  recordHistoryNavigation(url: string, title: string): void;
  updateHistoryTitle(url: string, title: string): void;
  forgetHistory(): void;
  emitShortcut(shortcut: BrowserShortcut): void;
  matchGuestShortcut(input: Input): BrowserShortcut | null;
  emitFindResult(result: Result): void;
  invalidateFind(): void;
  syncZoom(): void;
  /** Persist only URL/title changes; loading/console events remain hot-path state only. */
  persistTab(): void;
  emitCommentBadgeClick(tabId: string, anchorId: string, box: BrowserBounds | null): void;
}

export function installTabEvents(tab: ManagedTab, host: TabEventHost): void {
  const wc = tab.webContents;
  installBrowserFaviconEvents(tab, host);
  wc.once("destroyed", () => {
    host.invalidateFind();
    host.forgetHistory();
    host.tabDestroyed();
  });
  // A focused guest page swallows keydown before the renderer's window
  // listener can see it, so the browser-chrome chords (⌘T new tab, ⌘W close
  // tab) are intercepted here and relayed to the renderer.
  wc.on("before-input-event", (event, input) => {
    const shortcut = guestChrome(input, host.matchGuestShortcut(input));
    if (!shortcut) return;
    event.preventDefault();
    host.emitShortcut(shortcut);
  });
  // Electron 42 emits a single details object; the old positional (level,
  // message, line, sourceId) args are deprecated and unreliable at runtime.
  wc.on("console-message", (details) => {
    const message = details.message;
    // Comment-badge clicks ride in on a sentinel console line; relay them and
    // never record them as real console output.
    if (message.startsWith(COMMENT_BADGE_CLICK_SENTINEL)) {
      relayBadgeClick(tab.metadata.id, message, host);
      return;
    }
    pushBounded(
      tab.consoleEntries,
      consoleEntry(tab.metadata.id, details.level, message, details.lineNumber, details.sourceId),
      MAX_CONSOLE_PER_TAB,
    );
    // Read on demand by automation; the renderer's snapshot never carries it.
  });
  wc.on("will-navigate", (event) => {
    try {
      normalizeBrowserOpenUrl(event.url);
      host.invalidateFind();
    } catch (error) {
      event.preventDefault();
      host.setLastError(error instanceof Error ? error.message : String(error));
      host.emitState();
    }
  });
  wc.on("will-redirect", (event) => {
    if (tab.automationAccess !== "user" && isCadencrBrowserUrl(event.url)) {
      event.preventDefault();
      host.setLastError("Browser navigation to Cadencr's own origins is blocked.");
      host.emitState();
    }
  });
  wc.on("did-start-navigation", (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    invalidateBrowserDocument(wc);
    if (tab.externalAutomationOrigin !== originOf(details.url)) tab.externalAutomationOrigin = null;
    tab.consoleEntries.length = 0;
    tab.networkEntries.length = 0;
  });
  installPageLifecycleEvents(tab, host);
}

function installPageLifecycleEvents(tab: ManagedTab, host: TabEventHost): void {
  const wc = tab.webContents;
  wc.on("did-navigate", () => {
    host.setLastError(null);
    refreshTabMetadata(tab, host);
    host.persistTab();
    host.recordHistoryNavigation(wc.getURL(), pageTitle(wc));
    host.syncZoom();
  });
  wc.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
    if (!isMainFrame) return;
    host.invalidateFind();
    host.setLastError(null);
    refreshTabMetadata(tab, host);
    host.persistTab();
    host.recordHistoryNavigation(wc.getURL(), pageTitle(wc));
    host.syncZoom();
  });
  wc.on("found-in-page", (_event, result) => host.emitFindResult(result));
  wc.on("zoom-changed", () => queueMicrotask(host.syncZoom));
  wc.on("page-title-updated", () => {
    refreshTabMetadata(tab, host);
    host.persistTab();
    host.updateHistoryTitle(wc.getURL(), pageTitle(wc));
  });
  wc.on("did-fail-load", (_event, _code, description, url) => {
    host.setLastError(`${url}: ${description}`);
    host.emitState();
  });
}

// Parse a sentinel badge-click console line (`{ anchorId, box }` JSON) and hand
// it to the host. A malformed payload (should never happen — we emit it) is
// dropped rather than surfaced, since it is an internal transport detail.
function relayBadgeClick(tabId: string, message: string, host: TabEventHost): void {
  try {
    const payload: unknown = JSON.parse(message.slice(COMMENT_BADGE_CLICK_SENTINEL.length));
    if (!payload || typeof payload !== "object") return;
    const { anchorId, box } = payload as { anchorId?: unknown; box?: unknown };
    if (typeof anchorId !== "string") return;
    host.emitCommentBadgeClick(tabId, anchorId, parseBox(box));
  } catch {
    // Unparseable sentinel line — ignore.
  }
}

function parseBox(box: unknown): BrowserBounds | null {
  if (!box || typeof box !== "object") return null;
  const { x, y, width, height } = box as Record<string, unknown>;
  if ([x, y, width, height].some((value) => typeof value !== "number")) return null;
  return { x: x as number, y: y as number, width: width as number, height: height as number };
}

// Map a guest-page keydown to a browser-chrome chord, or null. Mirrors the
// renderer registry so the chords still fire while the guest page holds
// keyboard focus (the renderer's window listener never sees those events).
// Exported for unit testing.
export function guestChrome(
  input: Input,
  configuredShortcut?: BrowserShortcut | null,
): BrowserShortcut | null {
  if (input.type !== "keyDown") return null;
  if (configuredShortcut) return configuredShortcut;
  const mod = process.platform === "darwin" ? input.meta : input.control;
  if (!mod) return null;
  // Alt-modified Browser actions are registry-owned and arrive through
  // `configuredShortcut`; never retain a second hard-coded binding here.
  if (input.alt) return null;
  // ⌘+ / ⌘- → zoom the guest page. ⌘+ is really ⌘⇧=, so check before the
  // Shift branch. Matches the produced character, like the renderer registry.
  const zoom = zoomChord(input.key);
  if (zoom) return zoom;
  if (input.shift) return guestShiftChrome(input);
  switch (input.key.toLowerCase()) {
    case "r":
      return "reload";
    case "t":
      return "new-tab";
    case "w":
      return "close-tab";
    case "l":
      return "focus-url";
    case "s":
      return "add-comment";
    default:
      return null;
  }
}

// ⌘+ / ⌘- → zoom. "=" doubles as zoom-in so the unshifted key works too.
function zoomChord(key: string): BrowserShortcut | null {
  if (key === "+" || key === "=") return "zoom-in";
  if (key === "-") return "zoom-out";
  return null;
}

// Shift chords: tab switching (⌘⇧[ / ⌘⇧]) and feature-pane switching
// (⌘⇧A/T/G/E/B). Brackets match the physical `code` because Shift mangles
// "[" → "{"; letters stay layout-aware through `key`.
function guestShiftChrome(input: Input): BrowserShortcut | null {
  if (input.code === "BracketLeft") return "prev-tab";
  if (input.code === "BracketRight") return "next-tab";
  switch (input.key.toLowerCase()) {
    case "a":
      return "pane-agent";
    case "t":
      return "pane-terminal";
    case "g":
      return "pane-git";
    case "e":
      return "pane-editor";
    case "b":
      return "pane-browser";
    case "u":
      return "reopen-tab";
    default:
      return null;
  }
}

function refreshTabMetadata(tab: ManagedTab, host: TabEventHost): void {
  const wc = tab.webContents;
  updateTabMetadata(
    tab,
    { title: wc.getTitle() || wc.getURL(), url: wc.getURL() || DEFAULT_URL },
    host,
  );
}

function pageTitle(wc: WebContents): string {
  return wc.getTitle() || wc.getURL();
}
