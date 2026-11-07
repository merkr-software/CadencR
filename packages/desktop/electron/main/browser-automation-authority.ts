import type { ManagedTab } from "./browser-tab-events";
import type { BrowserAutomationState } from "./browser-types";
import { browserAutomationAccess } from "./browser-policy";
import { externalAutomationMatches } from "./browser-manager-utils";
import { browserDocumentRevision } from "./browser-document-security";
import { isBrowserOriginPolicyReady } from "./runtime-config";
import { isCadencrBrowserUrl } from "./browser-self-origin-policy";

/** Per-tab authorization boundary between user browsing and agent automation. */
export class BrowserAutomationAuthority {
  constructor(
    private readonly tabs: Map<string, ManagedTab>,
    private readonly snapshot: (scopeId?: number | null) => BrowserAutomationState,
  ) {}

  assert(tabId: string, scopeId?: number | null): ManagedTab {
    const tab = this.assertShared(tabId, scopeId);
    if (!this.canInspect(tab)) {
      throw new Error(
        "Browser automation cannot inspect local files, non-web pages, or Cadencr origins.",
      );
    }
    return tab;
  }

  /** Navigation may replace a shared blank page without inspecting its contents. */
  assertShared(tabId: string, scopeId?: number | null): ManagedTab {
    const tab = this.tabs.get(tabId);
    const normalizedScopeId = scopeId ?? null;
    if (!tab || tab.metadata.scopeId !== normalizedScopeId) {
      throw new Error("Browser tab is not available to this agent scope.");
    }
    if (tab.automationAccess === "user") {
      throw new Error("Browser tab is not shared with the agent.");
    }
    return tab;
  }

  state(scopeId?: number | null): BrowserAutomationState {
    const state = this.snapshot(scopeId ?? null);
    const allowedIds = new Set(
      state.tabs
        .filter((tab) => {
          const managed = this.tabs.get(tab.id);
          return managed && managed.automationAccess !== "user" && this.canInspect(managed);
        })
        .map((tab) => tab.id),
    );
    return {
      ...state,
      tabs: state.tabs.filter((tab) => allowedIds.has(tab.id)),
      activeTabId:
        state.activeTabId && allowedIds.has(state.activeTabId) ? state.activeTabId : null,
      consoleEntries: state.consoleEntries.filter(
        (entry) =>
          allowedIds.has(entry.tabId) &&
          (!entry.sourceUrl || browserAutomationAccess(entry.sourceUrl) !== "denied"),
      ),
      networkEntries: state.networkEntries.filter(
        (entry) => allowedIds.has(entry.tabId) && browserAutomationAccess(entry.url) !== "denied",
      ),
      error: null,
    };
  }

  guard(tabId: string, scopeId?: number | null): () => void {
    const tab = this.assert(tabId, scopeId);
    const url = tab.webContents.getURL();
    const revision = browserDocumentRevision(tab.webContents);
    return () => {
      const current = this.assert(tabId, scopeId);
      if (
        current !== tab ||
        current.webContents.getURL() !== url ||
        browserDocumentRevision(current.webContents) !== revision
      ) {
        throw new Error("Browser page changed during automation. Retry on the current page.");
      }
    };
  }

  private canInspect(tab: ManagedTab): boolean {
    if (!isBrowserOriginPolicyReady()) return false;
    if (tab.webContents.isDestroyed()) return false;
    // A human-only tab may have embedded a privileged page before sharing.
    // Request guards cannot remove an already-rendered frame from a screenshot.
    if (!inspectableFrames(tab.webContents)) return false;
    return [tab.metadata.url, tab.webContents.getURL()].every(
      (url) =>
        browserAutomationAccess(url) !== "denied" ||
        externalAutomationMatches(url, tab.externalAutomationOrigin),
    );
  }
}

function inspectableFrames(contents: ManagedTab["webContents"]): boolean {
  try {
    const main = contents.mainFrame;
    if (main.detached) return false;
    return main.framesInSubtree.every(
      (frame) =>
        !frame.detached && !frame.url.startsWith("file:") && !isCadencrBrowserUrl(frame.url),
    );
  } catch {
    // Electron invalidates frame handles during navigation; deny until stable.
    return false;
  }
}
