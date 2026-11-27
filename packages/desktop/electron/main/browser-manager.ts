import { BrowserWindow } from "electron";
import { isHttpBrowserUrl } from "../../src/shared/browser-url";
import { BrowserAgentAccessController } from "./browser-agent-access-controller";
import { BrowserAutomationAuthority } from "./browser-automation-authority";
import { toggleTabDevTools } from "./browser-devtools";
import type { BrowserDownloadManager } from "./browser-download-manager";
import { BrowserFocusGuard } from "./browser-focus-guard";
import { BrowserInspectionController } from "./browser-inspection-controller";
import { BrowserLibraryController } from "./browser-library-controller";
import { BrowserLibraryStore } from "./browser-library-store";
import { isIgnoredLoadUrlRejection } from "./browser-load-errors";
import { prepareBrowserShutdown } from "./browser-manager-downloads";
import { rendererBoundsToWindow } from "./browser-manager-layout";
import type { BrowserManagerState } from "./browser-manager-state";
import { profileFromSelection } from "./browser-manager-utils";
import {
  createBrowserManagerControllers,
  ensureBrowserAgentAccess,
} from "./browser-manager-wiring";
import type { BrowserOpenController, EnsureAgentAccessOptions } from "./browser-open-controller";
import { BrowserPageController } from "./browser-page-controller";
import { normalizeBrowserOpenUrl } from "./browser-policy";
import type { BrowserPopupController } from "./browser-popup-controller";
import type { BrowserResponsiveController } from "./browser-responsive-controller";
import { browserErrorMessage, browserScopeIssue } from "./browser-scope-failure";
import { BrowserScopeState } from "./browser-scope-state";
import { BrowserSiteApi } from "./browser-site-api";
import { BrowserSiteController } from "./browser-site-controller";
import type { BrowserTabCreationController } from "./browser-tab-creation-controller";
import { unknownBrowserTab } from "./browser-tab-errors";
import type { ManagedTab } from "./browser-tab-events";
import { BrowserTabLifecycle } from "./browser-tab-lifecycle";
import type { BrowserTabOrganizationController } from "./browser-tab-organization-controller";
import { BrowserTabSessionStore } from "./browser-tab-session-store";
import type { BrowserTabWorkspaceController } from "./browser-tab-workspace-controller";
import type {
  BrowserAutomationState,
  BrowserBounds,
  BrowserOpenUrlOptions,
  BrowserResponsiveRequest,
  BrowserStateSnapshot,
  BrowserTabError,
  BrowserTabMetadata,
} from "./browser-types";
import { BrowserViewLayout } from "./browser-view-layout";
import { sendToWindow } from "./safe-send";

export class BrowserManager {
  private readonly tabs = new Map<string, ManagedTab>();
  private readonly scopes = new BrowserScopeState();
  readonly focusGuard = new BrowserFocusGuard(() => this.getMainWindow());
  private readonly layout = new BrowserViewLayout(
    () => this.getMainWindow(),
    (tab, scale) => this.responsive.syncScale(tab, scale),
  );
  private readonly tabLifecycle = new BrowserTabLifecycle(this.tabs, this.layout);
  readonly downloads: BrowserDownloadManager;
  private readonly workspace: BrowserTabWorkspaceController;
  private readonly organization: BrowserTabOrganizationController;
  private readonly creator: BrowserTabCreationController;
  readonly popup: BrowserPopupController;
  private readonly opener: BrowserOpenController;
  private readonly stateAuthority: BrowserManagerState;
  private readonly responsive: BrowserResponsiveController;
  readonly library = new BrowserLibraryController(
    new BrowserLibraryStore(undefined, undefined, (change) =>
      sendToWindow(this.getMainWindow(), "browser:library-changed", change),
    ),
    (tabId) => this.requireTab(tabId),
    (message, scopeId) => console.warn("[browser] library error", { scopeId, message }),
  );
  private readonly siteController = new BrowserSiteController({
    send: (channel, payload) => sendToWindow(this.getMainWindow(), channel, payload),
    reportError: (message, tab) => this.reportTabError(tab, message),
  });
  readonly site = new BrowserSiteApi(
    this.siteController,
    (tabId) => this.requireTab(tabId),
    (scopeId) => this.stateAuthority.emit(scopeId),
    (tabId, shared) => this.agentAccess.syncExternalAccessChange(tabId, shared),
  );
  readonly agentAccess = new BrowserAgentAccessController({
    send: (channel, payload) => sendToWindow(this.getMainWindow(), channel, payload),
    activateTab: (tabId) => this.activateTab(tabId),
    emitState: (scopeId) => this.stateAuthority.emit(scopeId),
    suspendFocusGuard: (action) => this.focusGuard.suspend(action),
  });
  readonly automation = new BrowserAutomationAuthority(
    this.tabs,
    (scopeId) => this.automationState(scopeId),
    (scopeId) => this.state(scopeId),
  );
  readonly inspection = new BrowserInspectionController(
    (tabId) => this.requireTab(tabId),
    (tab) => this.responsive.inputScaleGuard(tab),
  );
  readonly page = new BrowserPageController({
    tabs: this.tabs,
    requireTab: (tabId) => this.requireTab(tabId),
    emitState: (scopeId) => this.stateAuthority.emit(scopeId),
    emitFindResult: (result) => sendToWindow(this.getMainWindow(), "browser:find-result", result),
    syncResponsive: (tab) => this.responsive.syncZoom(tab),
    clearTabError: (tab) => {
      if (this.setTabError(tab, null)) this.stateAuthority.emit(tab.metadata.scopeId);
    },
    retryFailedLoad: (tab) => this.retryFailedLoad(tab),
  });

  private readonly getMainWindow: () => BrowserWindow | null;
  constructor(
    getMainWindow: () => BrowserWindow | null,
    sessionStore = new BrowserTabSessionStore(),
  ) {
    this.getMainWindow = getMainWindow;
    const wired = createBrowserManagerControllers({
      tabs: this.tabs,
      scopes: this.scopes,
      layout: this.layout,
      lifecycle: this.tabLifecycle,
      focusGuard: this.focusGuard,
      site: this.siteController,
      library: this.library,
      page: this.page,
      agentAccess: this.agentAccess,
      automation: this.automation,
      inspection: this.inspection,
      sessionStore,
      getWindow: () => this.getMainWindow(),
      setTabError: (tab, error) => this.setTabError(tab, error),
      reportTabError: (tab, error) => this.reportTabError(tab, error),
      reportError: (error, scopeId) => this.reportError(error, scopeId),
      activateLive: (tabId) => this.activateLiveTab(tabId),
      activateTab: (tabId) => this.activateTab(tabId),
      navigate: (tabId, url) => this.navigate(tabId, url),
      toggleDevTools: (tabId) => this.toggleDevTools(tabId),
      applyLayout: () => this.applyLayout(),
      persistScope: (scopeId) => this.persistScope(scopeId),
      state: (scopeId) => this.state(scopeId),
      requireTab: (tabId) => this.requireTab(tabId),
      ensureAgentAccess: (tabId, scopeId, options) =>
        this.ensureAgentAccess(tabId, scopeId, options),
    });
    this.workspace = wired.workspace;
    this.stateAuthority = wired.stateAuthority;
    this.responsive = wired.responsive;
    this.downloads = wired.downloads;
    this.popup = wired.popup;
    this.creator = wired.creator;
    this.organization = wired.organization;
    this.opener = wired.opener;
  }

  createTab(
    rawUrl?: string,
    profileId = "fresh",
    scopeId: number | null = null,
  ): BrowserTabMetadata {
    const profile = profileFromSelection(profileId);
    return this.creator.create(rawUrl, profileId, profile, scopeId);
  }
  readonly tabCountsByScope = (): Record<number, number> => this.workspace.countByScope(this.tabs);
  async ensureScopeRestored(scopeId: number): Promise<void> {
    await this.workspace.ensureRestored(scopeId, this.scopes.activeTabId(scopeId));
  }
  async restoreScope(scopeId: number): Promise<BrowserStateSnapshot> {
    const activeId = await this.workspace.ensureRestored(scopeId, this.scopes.activeTabId(scopeId));
    if (
      activeId &&
      this.scopes.activeTabId(scopeId) === null &&
      (this.tabs.has(activeId) || this.workspace.dormantTab(activeId))
    ) {
      await this.activateTab(activeId);
    }
    return this.state(scopeId);
  }
  async restoreScopeMetadata(scopeId: number): Promise<BrowserStateSnapshot> {
    await this.ensureScopeRestored(scopeId);
    return this.state(scopeId);
  }
  navigate(tabId: string, rawUrl: string): BrowserTabMetadata {
    const tab = this.requireTab(tabId);
    const url = normalizeBrowserOpenUrl(rawUrl);
    tab.metadata = { ...tab.metadata, url };
    if (this.scopes.errors.clearForNavigation(tab.metadata.scopeId, tabId)) this.applyLayout();
    this.page.invalidateFind(tab);
    this.stateAuthority.emit(tab.metadata.scopeId);
    if (tab.profile.mode === "persistent" && tab.automationAccess !== "agent") {
      this.persistScope(tab.metadata.scopeId);
    }
    void tab.webContents.loadURL(url).catch((error: unknown) => {
      if (!isIgnoredLoadUrlRejection(error)) this.reportTabError(tab, error);
    });
    return tab.metadata;
  }
  navigateFromChrome(tabId: string, rawUrl: string): BrowserTabMetadata {
    const tab = this.requireTab(tabId);
    const normalizedUrl = normalizeBrowserOpenUrl(rawUrl);
    this.creator.promoteTemporaryForChrome(tab);
    return this.navigate(tabId, normalizedUrl);
  }
  async activateTab(tabId: string): Promise<BrowserTabMetadata> {
    const dormant = this.workspace.dormantTab(tabId);
    if (dormant) {
      const metadata = dormant.metadata;
      try {
        return this.creator.create(
          metadata.url,
          metadata.sessionProfileId,
          profileFromSelection(metadata.sessionProfileId),
          metadata.scopeId,
          "user",
          metadata,
          true,
        );
      } catch (error) {
        this.reportError(error, metadata.scopeId);
        throw error;
      }
    }
    return this.activateLiveTab(tabId);
  }
  private activateLiveTab(tabId: string): BrowserTabMetadata {
    const tab = this.requireTab(tabId);
    this.scopes.activate(tab.metadata.scopeId, tabId);
    this.scopes.refreshActiveFlags(this.tabs);
    this.applyLayout();
    this.stateAuthority.emit(tab.metadata.scopeId);
    if (this.workspace.noteActivation(tabId, this.tabs)) this.persistScope(tab.metadata.scopeId);
    return tab.metadata;
  }
  setSuppressed(value: boolean): void {
    if (this.layout.setSuppressed(value)) this.applyLayout();
  }
  private applyLayout(): void {
    this.layout.apply(
      this.tabs,
      this.scopes.active,
      this.scopes.bounds,
      this.scopes.rendererZoom,
      (tabId) => this.scopes.errors.hasViewportPageError(tabId),
    );
  }

  readonly closeTab = (tabId: string): Promise<BrowserStateSnapshot> => {
    this.agentAccess.cancelTab(
      tabId,
      "The browser tab was closed before agent access was approved.",
    );
    return this.organization.close(tabId);
  };
  async closeTabsForScope(scopeId: number): Promise<BrowserStateSnapshot> {
    this.agentAccess.cancelScope(
      scopeId,
      "The browser tab was closed before agent access was approved.",
    );
    this.scopes.errors.clearScope(scopeId);
    return this.downloads.closeScope(scopeId, () => this.organization.closeScope(scopeId));
  }
  readonly duplicateTab = (tabId: string): BrowserTabMetadata => this.organization.duplicate(tabId);
  readonly setTabPinned = (tabId: string, pinned: boolean): BrowserStateSnapshot =>
    this.organization.setPinned(tabId, pinned);
  readonly reorderTab = (tabId: string, targetIndex: number): BrowserStateSnapshot =>
    this.organization.reorder(tabId, targetIndex);
  async closeOtherTabs(tabId: string): Promise<BrowserStateSnapshot> {
    return this.organization.closeOthers(tabId);
  }
  readonly reopenLastClosedTab = (scopeId: number): BrowserTabMetadata | null =>
    this.organization.reopen(scopeId);
  readonly flushTabSessions = (): Promise<void> => this.workspace.flush();

  async prepareForWindowClose(): Promise<void> {
    this.agentAccess.cancelAll();
    await this.workspace.prepareForWindowClose(this.tabs, this.scopes.active);
    this.layout.detachAll();
    this.scopes.clearBounds();
  }
  async prepareForShutdown(): Promise<void> {
    this.agentAccess.cancelAll();
    await prepareBrowserShutdown(this.downloads, () => this.saveWorkspaceForQuit());
  }

  saveWorkspaceForQuit(): Promise<void> {
    return this.workspace.prepareForShutdown(this.tabs, this.scopes.active);
  }

  resumeAfterShutdownAbort(): void {
    this.workspace.resumeAfterShutdownAbort();
  }

  async finishVoluntaryQuit(): Promise<void> {
    this.agentAccess.cancelAll();
    await prepareBrowserShutdown(this.downloads, () => Promise.resolve());
  }

  setBounds(
    bounds: BrowserBounds,
    scopeId: number | null = null,
    zoomFactor?: number,
  ): BrowserStateSnapshot {
    const placed = rendererBoundsToWindow(this.getMainWindow(), bounds, zoomFactor);
    this.scopes.setBounds(scopeId, placed.bounds, placed.factor);
    this.applyLayout();
    return this.state(scopeId);
  }

  readonly setResponsive = (
    tabId: string,
    request: BrowserResponsiveRequest,
  ): Promise<BrowserTabMetadata> => this.responsive.set(this.requireTab(tabId), request);

  toggleDevTools(tabId: string): BrowserTabMetadata {
    const tab = this.requireTab(tabId);
    return toggleTabDevTools(
      tab,
      () => this.applyLayout(),
      () => this.stateAuthority.emit(tab.metadata.scopeId),
      () => this.responsive.devToolsLoaded(tab),
    );
  }

  openUrl(
    url: string,
    options: BrowserOpenUrlOptions = {},
    signal?: AbortSignal,
  ): Promise<BrowserTabMetadata> {
    return this.opener.open(url, options, signal);
  }
  openExternalUrl(
    url: string,
    options: BrowserOpenUrlOptions = {},
    signal?: AbortSignal,
  ): Promise<BrowserTabMetadata> {
    return this.opener.openExternal(url, options, signal);
  }

  readonly state = (scopeId?: number | null): BrowserStateSnapshot =>
    this.stateAuthority.snapshot(scopeId);
  readonly automationState = (scopeId?: number | null): BrowserAutomationState =>
    this.stateAuthority.automationSnapshot(scopeId);

  private persistScope(scopeId: number | null): void {
    if (scopeId === null) return;
    this.workspace.schedulePersistence(scopeId, this.tabs, this.scopes.activeTabId(scopeId));
  }

  activeScopeTabId(scopeId?: number | null): string | null {
    return this.scopes.activeTabId(scopeId);
  }

  ensureAgentAccess(
    tabId: string,
    scopeId: number | null,
    options: EnsureAgentAccessOptions = {},
  ): Promise<void> {
    return ensureBrowserAgentAccess(
      {
        tabs: this.tabs,
        workspace: this.workspace,
        automation: this.automation,
        agentAccess: this.agentAccess,
        inspection: this.inspection,
        activateTab: (id) => this.activateTab(id),
        emitState: (scope) => this.stateAuthority.emit(scope),
      },
      tabId,
      scopeId,
      options,
    );
  }

  clearError(scopeId: number | null, tabId?: string | null): void {
    if (!this.scopes.errors.dismiss(scopeId, tabId)) return;
    if (tabId != null) this.applyLayout();
    this.stateAuthority.emit(scopeId);
  }

  private retryFailedLoad(tab: ManagedTab): boolean {
    const error = this.scopes.errors.tabErrorFor(tab.metadata.id);
    const retryableLoad = error?.kind === "load" || error?.kind === "security";
    if (!error?.retryable || !retryableLoad || !error.url || !isHttpBrowserUrl(error.url)) {
      return false;
    }
    this.navigate(tab.metadata.id, error.url);
    return true;
  }

  private reportError(error: unknown, scopeId: number | null): void {
    if (this.scopes.errors.report(scopeId, browserErrorMessage(error), browserScopeIssue(error))) {
      this.stateAuthority.emit(scopeId);
    }
  }

  private setTabError(tab: Pick<ManagedTab, "metadata">, error: BrowserTabError | null): boolean {
    const { id, scopeId } = tab.metadata;
    const changed =
      error === null
        ? this.scopes.errors.releaseTab(id)
        : this.tabs.has(id) && this.scopes.errors.reportTab(scopeId, id, error);
    if (changed) this.applyLayout();
    return changed;
  }

  private reportTabError(tab: Pick<ManagedTab, "metadata">, error: unknown): void {
    const tabError: BrowserTabError = {
      kind: "internal",
      failure: { reason: "internal" },
      title: "Browser error",
      description: browserErrorMessage(error),
      retryable: false,
    };
    if (this.setTabError(tab, tabError)) this.stateAuthority.emit(tab.metadata.scopeId);
  }

  private requireTab(tabId: string): ManagedTab {
    const tab = this.tabs.get(tabId);
    if (!tab) throw unknownBrowserTab(tabId);
    return tab;
  }
}
