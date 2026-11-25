import type { BrowserWindow } from "electron";
import { httpBrowserOrigin } from "../../src/shared/browser-url";
import type { BrowserAgentAccessController } from "./browser-agent-access-controller";
import {
  isApprovableBrowserUrl,
  type BrowserAutomationAuthority,
} from "./browser-automation-authority";
import { inspectTabElement } from "./browser-devtools";
import type { BrowserDownloadManager } from "./browser-download-manager";
import type { BrowserFocusGuard } from "./browser-focus-guard";
import type { BrowserInspectionController } from "./browser-inspection-controller";
import type { BrowserLibraryController } from "./browser-library-controller";
import { createBrowserDownloadManager } from "./browser-manager-downloads";
import { BrowserManagerState } from "./browser-manager-state";
import { MAX_NETWORK_PER_TAB } from "./browser-manager-tabs";
import { applyTabAgentAccess, profileFromSelection, pushBounded } from "./browser-manager-utils";
import { BrowserNetworkCollector } from "./browser-network-collector";
import { BrowserOpenController, type EnsureAgentAccessOptions } from "./browser-open-controller";
import type { BrowserPageController } from "./browser-page-controller";
import { BrowserPopupController } from "./browser-popup-controller";
import { BrowserResponsiveController } from "./browser-responsive-controller";
import { responsiveNativeScale } from "./browser-responsive-layout";
import type { BrowserScopeState } from "./browser-scope-state";
import type { BrowserSiteController } from "./browser-site-controller";
import { BrowserTabCloseController } from "./browser-tab-close-controller";
import { BrowserTabCreationController } from "./browser-tab-creation-controller";
import type { ManagedTab } from "./browser-tab-events";
import type { BrowserTabLifecycle } from "./browser-tab-lifecycle";
import { BrowserTabOrganizationController } from "./browser-tab-organization-controller";
import type { BrowserTabSessionStore } from "./browser-tab-session-store";
import { BrowserTabWorkspaceController } from "./browser-tab-workspace-controller";
import type { BrowserStateSnapshot, BrowserTabError, BrowserTabMetadata } from "./browser-types";
import type { BrowserViewLayout } from "./browser-view-layout";

export interface BrowserManagerControllers {
  workspace: BrowserTabWorkspaceController;
  stateAuthority: BrowserManagerState;
  responsive: BrowserResponsiveController;
  downloads: BrowserDownloadManager;
  popup: BrowserPopupController;
  creator: BrowserTabCreationController;
  organization: BrowserTabOrganizationController;
  opener: BrowserOpenController;
}

export interface BrowserManagerWiringDeps {
  tabs: Map<string, ManagedTab>;
  scopes: BrowserScopeState;
  layout: BrowserViewLayout;
  lifecycle: BrowserTabLifecycle;
  focusGuard: BrowserFocusGuard;
  site: BrowserSiteController;
  library: BrowserLibraryController;
  page: BrowserPageController;
  agentAccess: BrowserAgentAccessController;
  automation: BrowserAutomationAuthority;
  inspection: BrowserInspectionController;
  sessionStore: BrowserTabSessionStore;
  getWindow: () => BrowserWindow | null;
  setTabError: (tab: ManagedTab, error: BrowserTabError | null) => boolean;
  reportTabError: (tab: ManagedTab, error: unknown) => void;
  reportError: (error: unknown, scopeId: number | null) => void;
  activateLive: (tabId: string) => BrowserTabMetadata;
  activateTab: (tabId: string) => Promise<BrowserTabMetadata>;
  navigate: (tabId: string, url: string) => BrowserTabMetadata;
  toggleDevTools: (tabId: string) => BrowserTabMetadata;
  applyLayout: () => void;
  persistScope: (scopeId: number | null) => void;
  state: (scopeId?: number | null) => BrowserStateSnapshot;
  requireTab: (tabId: string) => ManagedTab;
  ensureAgentAccess: (
    tabId: string,
    scopeId: number | null,
    options?: EnsureAgentAccessOptions,
  ) => Promise<void>;
}

export function createBrowserManagerControllers(
  deps: BrowserManagerWiringDeps,
): BrowserManagerControllers {
  const workspace = new BrowserTabWorkspaceController(deps.sessionStore, deps.reportError);
  const stateAuthority = new BrowserManagerState(deps.tabs, deps.scopes, workspace, deps.getWindow);
  const closer = createTabCloser(deps, stateAuthority);
  const network = createNetworkCollector(deps.tabs);
  const responsive = new BrowserResponsiveController({
    applyLayout: deps.applyLayout,
    emitState: (scopeId) => stateAuthority.emit(scopeId),
    reportError: (error, scopeId) => deps.reportError(error, scopeId),
    nativeScale: (tab, request) => responsiveNativeScale(deps.layout, deps.scopes, tab, request),
  });
  const downloads = createBrowserDownloadManager({
    lifecycle: deps.lifecycle,
    getWindow: deps.getWindow,
    reportError: (message, scopeId) => deps.reportError(message, scopeId),
  });
  let creator!: BrowserTabCreationController;
  const popup = new BrowserPopupController({
    getWindow: deps.getWindow,
    currentUrl: (tabId) => deps.tabs.get(tabId)?.webContents.getURL() ?? null,
    assertCanCreateNative: (parent, temporary) => creator.assertCanCreateNative(parent, temporary),
    createNativeChild: (parent, details, options, background, temporary) =>
      creator.createNativeChild(parent, details, options, background, temporary),
    reportError: (error, scopeId) => deps.reportError(error, scopeId),
  });
  creator = new BrowserTabCreationController({
    tabs: deps.tabs,
    workspace,
    lifecycle: deps.lifecycle,
    closer,
    network,
    focusGuard: deps.focusGuard,
    downloads,
    site: deps.site,
    library: deps.library,
    page: deps.page,
    popup,
    responsive,
    agentAccess: deps.agentAccess,
    host: {
      getWindow: deps.getWindow,
      setTabError: deps.setTabError,
      reportTabError: deps.reportTabError,
      reportError: deps.reportError,
      emitState: (scopeId) => stateAuthority.emit(scopeId),
      emitCounts: () => stateAuthority.emitCounts(),
      emitShortcut: (shortcut) => stateAuthority.emitShortcut(shortcut),
      activate: deps.activateLive,
      activateFallback: deps.activateTab,
      activeTabId: (scopeId) => deps.scopes.activeTabId(scopeId),
      navigate: deps.navigate,
      inspectElement: (tabId, x, y) =>
        inspectTabElement(deps.requireTab(tabId), x, y, () => deps.toggleDevTools(tabId)),
      persist: deps.persistScope,
    },
  });
  const organization = new BrowserTabOrganizationController(
    deps.tabs,
    deps.scopes,
    workspace,
    closer,
    {
      activate: deps.activateTab,
      create: (source, profile, metadata) =>
        creator.create(
          source.url,
          source.sessionProfileId,
          profile,
          source.scopeId,
          "user",
          metadata,
        ),
      persist: deps.persistScope,
      emitCounts: () => stateAuthority.emitCounts(),
      applyLayout: deps.applyLayout,
      emitState: (scopeId) => stateAuthority.emit(scopeId),
      state: deps.state,
    },
  );
  const opener = new BrowserOpenController(deps.automation, deps.inspection, {
    activeTabId: (scopeId) => deps.scopes.activeTabId(scopeId),
    navigate: deps.navigate,
    createAgentTab: (url, scopeId) =>
      creator.create(url, "fresh", profileFromSelection("fresh"), scopeId, "agent"),
    requireTab: deps.requireTab,
    ensureAgentAccess: deps.ensureAgentAccess,
  });
  return { workspace, stateAuthority, responsive, downloads, popup, creator, organization, opener };
}

function createTabCloser(
  deps: BrowserManagerWiringDeps,
  stateAuthority: BrowserManagerState,
): BrowserTabCloseController {
  return new BrowserTabCloseController(deps.tabs, deps.scopes, deps.lifecycle, {
    emitCounts: () => stateAuthority.emitCounts(),
    activate: (tabId) => {
      const scopeId = deps.tabs.get(tabId)?.metadata.scopeId ?? null;
      void deps.activateTab(tabId).catch((error: unknown) => deps.reportError(error, scopeId));
    },
    applyLayout: deps.applyLayout,
    emitState: (scope) => stateAuthority.emit(scope),
    reportError: deps.reportError,
    invalidateFind: (tab) => deps.page.invalidateFind(tab),
  });
}

function createNetworkCollector(tabs: Map<string, ManagedTab>): BrowserNetworkCollector {
  return new BrowserNetworkCollector(
    (webContentsId, entry) => {
      const tab = [...tabs.values()].find((t) => t.webContents.id === webContentsId);
      if (!tab) return;
      pushBounded(tab.networkEntries, { ...entry, tabId: tab.metadata.id }, MAX_NETWORK_PER_TAB);
    },
    (id) =>
      [...tabs.values()].find((tab) => tab.webContents.id === id)?.automationAccess !== "user",
  );
}

export interface BrowserAgentAccessDeps {
  tabs: Map<string, ManagedTab>;
  workspace: BrowserTabWorkspaceController;
  automation: BrowserAutomationAuthority;
  agentAccess: BrowserAgentAccessController;
  inspection: BrowserInspectionController;
  activateTab: (tabId: string) => Promise<BrowserTabMetadata>;
  emitState: (scopeId: number | null) => void;
}

/** Ensure a live or dormant tab is shared with the agent, prompting before waking dormant tabs. */
export async function ensureBrowserAgentAccess(
  deps: BrowserAgentAccessDeps,
  tabId: string,
  scopeId: number | null,
  options: EnsureAgentAccessOptions = {},
): Promise<void> {
  const { allowBlank = false, targetUrl, signal } = options;
  const existing = deps.tabs.get(tabId);
  if (existing) {
    if (existing.metadata.scopeId !== scopeId) {
      throw new Error("Browser tab is not available to this agent scope.");
    }
    if (existing.automationAccess !== "user") return;
    deps.automation.assertApprovable(tabId, scopeId, allowBlank);
    await deps.agentAccess.requestAccess(existing, { targetUrl, signal });
    return;
  }
  const dormant = deps.workspace.dormantTab(tabId);
  if (!dormant || dormant.metadata.scopeId !== scopeId) {
    throw new Error("Browser tab is not available to this agent scope.");
  }
  if (!isApprovableBrowserUrl(dormant.metadata.url, allowBlank)) {
    throw new Error(
      "Browser automation cannot inspect local files, non-web pages, or Cadencr origins.",
    );
  }
  const approvedOrigin = httpBrowserOrigin(dormant.metadata.url);
  await deps.agentAccess.requestDormantAccess(dormant.metadata, { targetUrl, signal });
  await deps.activateTab(tabId);
  const tab = deps.tabs.get(tabId);
  if (!tab || tab.metadata.scopeId !== scopeId || tab.webContents.isDestroyed()) {
    throw new Error("Browser tab is no longer available.");
  }
  if (!allowBlank) {
    await deps.inspection.waitForLoad(tabId);
    const liveUrl = tab.webContents.getURL() || tab.metadata.url;
    if (tab.webContents.isDestroyed() || httpBrowserOrigin(liveUrl) !== approvedOrigin) {
      throw new Error("The page changed before agent access was approved.");
    }
    deps.automation.assertApprovable(tabId, scopeId, false);
  }
  if (applyTabAgentAccess(tab, true, approvedOrigin)) deps.emitState(scopeId);
}
