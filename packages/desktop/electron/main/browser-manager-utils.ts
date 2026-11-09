import { randomUUID } from "node:crypto";
import type { BrowserWindow, WebContents } from "electron";
import type { ManagedTab, TabEventHost } from "./browser-tab-events";
import { browserAutomationAccess } from "./browser-policy";
import { isCadencrBrowserUrl } from "./browser-self-origin-policy";
import {
  browserPartitionForProfile,
  createBrowserProfile,
  type BrowserProfile,
} from "./browser-profiles";
import type {
  BrowserConsoleEntry,
  BrowserElementContext,
  BrowserNetworkEntry,
  BrowserShortcut,
  BrowserTabMetadata,
} from "./browser-types";
import { DEFAULT_BROWSER_RESPONSIVE_STATE } from "../../src/shared/browser-responsive";
import { sendToWindow } from "./safe-send";

const DEFAULT_URL = "about:blank";

export function assertBrowserMutationAllowed(liveUrl: string): void {
  if (browserAutomationAccess(liveUrl) !== "full") {
    throw new Error("Browser automation is allowed only for localhost tabs.");
  }
}

/**
 * Origin of any URL, or null when it can't be parsed (e.g. about:blank). Unlike
 * the origin-store's history helper this is intentionally scheme-agnostic — it
 * backs the external-automation check, which only ever compares http(s) origins.
 */
export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Whether a tab whose external automation was unlocked for `unlockedOrigin` may
 * still be mutated at `liveUrl`. The unlock is scoped to the approved origin, so
 * a tab that later navigates elsewhere (link click, redirect) re-locks itself.
 */
export function externalAutomationMatches(liveUrl: string, unlockedOrigin: string | null): boolean {
  return (
    unlockedOrigin !== null &&
    /^https?:/.test(liveUrl) &&
    !isCadencrBrowserUrl(liveUrl) &&
    originOf(liveUrl) === unlockedOrigin
  );
}

// One ⌘+/⌘- step multiplies the guest page's own zoom factor (independent of
// the desktop UI zoom), clamped to a usable range so a page can't shrink to
// nothing or blow up past readability.
const ZOOM_STEP = 1.2;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 5;

export function zoomWebContents(wc: WebContents, direction: "in" | "out"): void {
  const multiplier = direction === "in" ? ZOOM_STEP : 1 / ZOOM_STEP;
  wc.setZoomFactor(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, wc.getZoomFactor() * multiplier)));
}

// Chords whose target lives in renderer chrome. When one is relayed from a
// focused guest, reclaim OS focus before the renderer focuses its own control.
const RENDERER_FOCUS_SHORTCUTS = new Set<BrowserShortcut>([
  "find",
  "focus-url",
  "downloads",
  "pane-agent",
  "pane-terminal",
  "pane-git",
  "pane-editor",
  "navigate-back",
  "navigate-forward",
]);

/**
 * Make the renderer the OS first responder again. A click inside a guest view
 * leaves keyboard focus there, and a DOM `.focus()` in the renderer cannot take
 * it back — only the main process can.
 */
export function reclaimRendererFocus(win: BrowserWindow | null): void {
  if (win && !win.isDestroyed() && !win.webContents.isFocused()) win.webContents.focus();
}

export function reclaimFocusForShortcut(
  win: BrowserWindow | null,
  shortcut: BrowserShortcut,
): void {
  if (RENDERER_FOCUS_SHORTCUTS.has(shortcut)) reclaimRendererFocus(win);
}

/**
 * Hand the renderer a chord a focused guest view swallowed (the renderer
 * listens on `browser:shortcut`), reclaiming focus only for chords that land
 * on renderer chrome.
 */
export function relayGuestShortcut(win: BrowserWindow | null, shortcut: BrowserShortcut): void {
  reclaimFocusForShortcut(win, shortcut);
  sendToWindow(win, "browser:shortcut", shortcut);
}

export function tabDiagnostics(
  consoleEntries: BrowserConsoleEntry[],
  networkEntries: BrowserNetworkEntry[],
): BrowserElementContext["diagnostics"] {
  return {
    consoleErrors: consoleEntries.filter((entry) => entry.level === "error").slice(-20),
    failedNetworkRequests: networkEntries
      .filter((entry) => entry.failureReason || (entry.status ?? 0) >= 400)
      .slice(-20),
  };
}

export function secureWebPreferences(profile: BrowserProfile): Electron.WebPreferences {
  return {
    partition: browserPartitionForProfile(profile),
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    plugins: false,
    webviewTag: false,
    devTools: true,
  };
}

/** Harden child preferences while retaining opaque fields used by Electron's opener plumbing. */
export function secureChildWebPreferences(
  profile: BrowserProfile,
  native?: Electron.WebPreferences,
): Electron.WebPreferences {
  return {
    ...native,
    session: undefined,
    preload: undefined,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    ...secureWebPreferences(profile),
  };
}

export function metadataFor(
  id: string,
  profileId: string,
  scopeId: number | null,
): BrowserTabMetadata {
  return {
    id,
    title: "New tab",
    url: DEFAULT_URL,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    sessionProfileId: profileId,
    isActive: false,
    devToolsOpen: false,
    pinned: false,
    suspended: false,
    zoomPercent: 100,
    responsive: { ...DEFAULT_BROWSER_RESPONSIVE_STATE },
    scopeId,
  };
}

export function updateTabMetadata(
  tab: ManagedTab,
  patch: Partial<BrowserTabMetadata>,
  host: Pick<TabEventHost, "emitState">,
): void {
  const wc = tab.webContents;
  tab.metadata = {
    ...tab.metadata,
    ...patch,
    canGoBack: wc.canGoBack(),
    canGoForward: wc.canGoForward(),
  };
  host.emitState();
}

/**
 * Resolve a stable external selection into its actual Electron profile. `fresh`
 * deliberately generates a new identity once; callers opening child tabs must
 * retain the returned profile rather than resolving the selection again.
 */
export function profileFromSelection(selectionId: string): BrowserProfile {
  if (selectionId === "fresh") return createBrowserProfile("fresh");
  if (selectionId === "feature") return createBrowserProfile("feature", "feature");
  return createBrowserProfile("persistent", selectionId.replace(/^persistent:/, ""));
}

export function consoleEntry(
  tabId: string,
  level: number | string,
  message: string,
  lineNumber: number,
  sourceUrl: string,
): BrowserConsoleEntry {
  return {
    id: randomUUID(),
    tabId,
    level: consoleLevelName(level),
    message,
    sourceUrl,
    lineNumber,
    timestamp: new Date().toISOString(),
  };
}

// Electron 42 reports the level as a string ('debug' | 'info' | 'warning' |
// 'error'); older numeric levels (0–3) are still mapped for safety.
export function consoleLevelName(level: number | string): string {
  if (typeof level === "string") return level === "debug" ? "verbose" : level;
  return ["verbose", "info", "warning", "error"][level] ?? "info";
}

export function pushBounded<T>(items: T[], item: T, limit: number): void {
  items.push(item);
  if (items.length > limit) items.splice(0, items.length - limit);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Validates the object returned by an injected in-page script. Returns it typed
// when `isValid` passes, otherwise throws the page-supplied `error` (if any) or
// `fallbackMessage`.
export function expectScriptResult<T>(
  result: unknown,
  isValid: (record: Record<string, unknown>) => boolean,
  fallbackMessage: string,
): T {
  if (isRecord(result) && isValid(result)) return result as unknown as T;
  const reason = isRecord(result) && typeof result.error === "string" ? result.error : null;
  throw new Error(reason ?? fallbackMessage);
}

export function isElementPayload(value: unknown): value is BrowserElementContext["element"] {
  return (
    isRecord(value) &&
    Array.isArray(value.selectorCandidates) &&
    typeof value.tagName === "string" &&
    isRecord(value.attributes) &&
    isRecord(value.boundingBox) &&
    isRecord(value.computedStyles)
  );
}
