import { isHttpBrowserUrl } from "../../src/shared/browser-url";
import { browserDocumentRevision } from "./browser-document-security";
import { externalAutomationMatches } from "./browser-manager-utils";
import { browserAutomationAccess } from "./browser-policy";
import { privacyForProfileMode, privacyFromProfileId } from "./browser-profiles";
import { isCadencrBrowserUrl } from "./browser-self-origin-policy";
import type { ManagedTab } from "./browser-tab-events";
import type {
  BrowserAgentAccess,
  BrowserAgentTabSummary,
  BrowserAgentTabsList,
  BrowserAutomationState,
  BrowserConsoleEntry,
  BrowserNetworkEntry,
  BrowserStateSnapshot,
  BrowserTabMetadata,
  BrowserTabPrivacy,
} from "./browser-types";
import { isBrowserOriginPolicyReady } from "./runtime-config";

const CANNOT_INSPECT_ERROR =
  "Browser automation cannot inspect local files, non-web pages, or Cadencr origins.";

export function isApprovableBrowserUrl(rawUrl: string, allowBlank = false): boolean {
  if (!isBrowserOriginPolicyReady()) return false;
  return isApprovableUrl(rawUrl, allowBlank);
}

/** Per-tab authorization boundary between user browsing and agent automation. */
export class BrowserAutomationAuthority {
  constructor(
    private readonly tabs: Map<string, ManagedTab>,
    private readonly snapshot: (scopeId?: number | null) => BrowserAutomationState,
    private readonly stateSnapshot?: (scopeId?: number | null) => BrowserStateSnapshot,
  ) {}

  isSharedOrAgent(tabId: string, scopeId?: number | null): boolean {
    const tab = this.tabs.get(tabId);
    return !!tab && tab.metadata.scopeId === (scopeId ?? null) && tab.automationAccess !== "user";
  }

  assert(tabId: string, scopeId?: number | null): ManagedTab {
    const tab = this.assertShared(tabId, scopeId);
    if (!this.canInspect(tab)) throw new Error(CANNOT_INSPECT_ERROR);
    return tab;
  }

  /** Navigation may replace a shared blank page without inspecting its contents. */
  assertShared(tabId: string, scopeId?: number | null): ManagedTab {
    const tab = this.requireScopedTab(tabId, scopeId);
    if (tab.automationAccess === "user") {
      throw new Error("Browser tab is not shared with the agent.");
    }
    return tab;
  }

  assertApprovable(tabId: string, scopeId?: number | null, allowBlank = false): ManagedTab {
    const tab = this.requireScopedTab(tabId, scopeId);
    const liveUrl = tab.webContents.getURL();
    if (
      !this.hasInspectableFrameTree(tab) ||
      !isApprovableUrl(tab.metadata.url, allowBlank) ||
      (liveUrl !== tab.metadata.url && !isApprovableUrl(liveUrl, allowBlank))
    ) {
      throw new Error(CANNOT_INSPECT_ERROR);
    }
    return tab;
  }

  listTabs(scopeId?: number | null): BrowserAgentTabsList {
    const normalizedScopeId = scopeId ?? null;
    if (!isBrowserOriginPolicyReady()) {
      return { scopeId: normalizedScopeId, activeTabId: null, tabs: [] };
    }
    const state = this.stateSnapshot
      ? this.stateSnapshot(normalizedScopeId)
      : this.snapshot(normalizedScopeId);
    const resolvedScopeId = state.scopeId ?? normalizedScopeId;
    const tabs: BrowserAgentTabSummary[] = [];
    let activeTabId: string | null = null;
    for (const tab of state.tabs) {
      const summary = this.summarizeTab(tab);
      if (!summary) continue;
      tabs.push(summary);
      if (summary.id === state.activeTabId) activeTabId = summary.id;
    }
    return { scopeId: resolvedScopeId, activeTabId, tabs };
  }

  tabLogs(
    tabId: string,
    scopeId?: number | null,
  ): { consoleEntries: BrowserConsoleEntry[]; networkEntries: BrowserNetworkEntry[] } {
    const tab = this.assert(tabId, scopeId);
    return {
      consoleEntries: tab.consoleEntries.filter((entry) =>
        isAllowedConsoleEntry(entry, tab.externalAutomationOrigin),
      ),
      networkEntries: tab.networkEntries.filter((entry) =>
        isAllowedNetworkEntry(entry, tab.externalAutomationOrigin),
      ),
    };
  }

  state(scopeId?: number | null): BrowserAutomationState {
    const state = this.snapshot(scopeId ?? null);
    const allowedTabs = new Map<string, ManagedTab>();
    for (const tab of state.tabs) {
      const managed = this.tabs.get(tab.id);
      if (managed && managed.automationAccess !== "user" && this.canInspect(managed)) {
        allowedTabs.set(tab.id, managed);
      }
    }
    return {
      ...state,
      tabs: state.tabs.filter((tab) => allowedTabs.has(tab.id)),
      activeTabId:
        state.activeTabId && allowedTabs.has(state.activeTabId) ? state.activeTabId : null,
      consoleEntries: state.consoleEntries.filter((entry) => {
        const tab = allowedTabs.get(entry.tabId);
        return !!tab && isAllowedConsoleEntry(entry, tab.externalAutomationOrigin);
      }),
      networkEntries: state.networkEntries.filter((entry) => {
        const tab = allowedTabs.get(entry.tabId);
        return !!tab && isAllowedNetworkEntry(entry, tab.externalAutomationOrigin);
      }),
      error: null,
      tabError: null,
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

  private requireScopedTab(tabId: string, scopeId?: number | null): ManagedTab {
    const tab = this.tabs.get(tabId);
    const normalizedScopeId = scopeId ?? null;
    if (!tab || tab.metadata.scopeId !== normalizedScopeId) {
      throw new Error("Browser tab is not available to this agent scope.");
    }
    return tab;
  }

  private hasInspectableFrameTree(tab: ManagedTab): boolean {
    if (!isBrowserOriginPolicyReady()) return false;
    if (tab.webContents.isDestroyed()) return false;
    // A human-only tab may have embedded a privileged page before sharing.
    // Request guards cannot remove an already-rendered frame from a screenshot.
    return inspectableFrames(tab.webContents);
  }

  private summarizeTab(tab: BrowserTabMetadata): BrowserAgentTabSummary | null {
    const managed = this.tabs.get(tab.id);
    if (managed) {
      if (!this.hasInspectableFrameTree(managed)) return null;
      const liveUrl = managed.webContents.getURL();
      if (!isListableWebUrl(managed.metadata.url)) return null;
      if (liveUrl !== managed.metadata.url && !isListableWebUrl(liveUrl)) return null;
      const privacy = managed.profile
        ? privacyForProfileMode(managed.profile.mode)
        : privacyFromProfileId(tab.sessionProfileId);
      return toTabSummary(tab, privacy, managed.automationAccess);
    }
    if (!tab.suspended || !isListableWebUrl(tab.url)) return null;
    return toTabSummary(tab, privacyFromProfileId(tab.sessionProfileId), "user");
  }

  private canInspect(tab: ManagedTab): boolean {
    if (!this.hasInspectableFrameTree(tab)) return false;
    const liveUrl = tab.webContents.getURL();
    if (!isAllowedLogUrl(tab.metadata.url, tab.externalAutomationOrigin)) return false;
    return liveUrl === tab.metadata.url || isAllowedLogUrl(liveUrl, tab.externalAutomationOrigin);
  }
}

function toTabSummary(
  tab: BrowserTabMetadata,
  privacy: BrowserTabPrivacy,
  agentAccess: BrowserAgentAccess,
): BrowserAgentTabSummary {
  return {
    id: tab.id,
    title: tab.title,
    url: tab.url,
    loading: tab.loading,
    isActive: tab.isActive,
    pinned: tab.pinned,
    suspended: tab.suspended,
    privacy,
    agentAccess,
    requiresApproval: agentAccess === "user",
  };
}

function isAllowedLogUrl(url: string, externalOrigin: string | null): boolean {
  return (
    browserAutomationAccess(url) !== "denied" || externalAutomationMatches(url, externalOrigin)
  );
}

function isAllowedConsoleEntry(entry: BrowserConsoleEntry, externalOrigin: string | null): boolean {
  return !entry.sourceUrl || isAllowedLogUrl(entry.sourceUrl, externalOrigin);
}

function isAllowedNetworkEntry(entry: BrowserNetworkEntry, externalOrigin: string | null): boolean {
  return isAllowedLogUrl(entry.url, externalOrigin);
}

function isListableWebUrl(rawUrl: string): boolean {
  return isHttpBrowserUrl(rawUrl) && !isCadencrBrowserUrl(rawUrl);
}

function isApprovableUrl(rawUrl: string, allowBlank: boolean): boolean {
  if (allowBlank && (rawUrl === "about:blank" || rawUrl === "")) return true;
  return isListableWebUrl(rawUrl);
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
