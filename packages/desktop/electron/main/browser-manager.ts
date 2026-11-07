import { BrowserWindow } from "electron";
import { normalizeBrowserOpenUrl } from "./browser-policy";
import { BrowserFocusGuard } from "./browser-focus-guard";
import type { BrowserDownloadManager } from "./browser-download-manager";
import { createBrowserDownloadManager, prepareBrowserShutdown } from "./browser-manager-downloads";
import { BrowserLibraryController } from "./browser-library-controller";
import { BrowserLibraryStore } from "./browser-library-store";
import { BrowserManagerState } from "./browser-manager-state";
import { BrowserAutomationAuthority } from "./browser-automation-authority";
import { inspectTabElement, toggleTabDevTools } from "./browser-devtools";
import { BrowserInspectionController } from "./browser-inspection-controller";
import { BrowserNetworkCollector } from "./browser-network-collector";
import { BrowserOpenController } from "./browser-open-controller";
import { BrowserPageController } from "./browser-page-controller";
import { BrowserPopupController } from "./browser-popup-controller";
import { BrowserResponsiveController } from "./browser-responsive-controller";
import { responsiveNativeScale } from "./browser-responsive-layout";
import type { ManagedTab } from "./browser-tab-events";
import { BrowserTabCloseController } from "./browser-tab-close-controller";
import { BrowserTabCreationController } from "./browser-tab-creation-controller";
import { BrowserTabOrganizationController } from "./browser-tab-organization-controller";
import { BrowserTabLifecycle } from "./browser-tab-lifecycle";
import { BrowserTabSessionStore } from "./browser-tab-session-store";
import { BrowserTabWorkspaceController } from "./browser-tab-workspace-controller";
import { BrowserScopeState } from "./browser-scope-state";
import { BrowserSiteApi } from "./browser-site-api";
import { BrowserSiteController } from "./browser-site-controller";
import { rendererBoundsToWindow } from "./browser-manager-layout";
import { BrowserViewLayout } from "./browser-view-layout";
import { profileFromSelection, pushBounded } from "./browser-manager-utils";
import { sendToWindow } from "./safe-send";
import { MAX_NETWORK_PER_TAB } from "./browser-manager-tabs";
import type {
  BrowserAutomationState,
  BrowserBounds,
  BrowserOpenUrlOptions,
  BrowserResponsiveRequest,
  BrowserStateSnapshot,
  BrowserTabMetadata,
} from "./browser-types";

export class BrowserManager {
  private readonly tabs = new Map<string, ManagedTab>();
  private readonly scopes = new BrowserScopeState();
  private lastError: string | null = null;
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
  private readonly tabCloser = new BrowserTabCloseController(
    this.tabs,
    this.scopes,
    this.tabLifecycle,
    {
      emitCounts: () => this.stateAuthority.emitCounts(),
      activate: (tabId) => {
        void this.activateTab(tabId).catch((error: unknown) => {
          this.lastError = error instanceof Error ? error.message : String(error);
        });
      },
      applyLayout: () => this.applyLayout(),
      emitState: (scope) => this.stateAuthority.emit(scope),
      reportError: (error, scope) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.stateAuthority.emit(scope);
      },
      invalidateFind: (tab) => this.page.invalidateFind(tab),
    },
  );
  readonly library = new BrowserLibraryController(
    new BrowserLibraryStore(undefined, undefined, (change) =>
      sendToWindow(this.getMainWindow(), "browser:library-changed", change),
    ),
    (tabId) => this.requireTab(tabId),
    (message, scopeId) => {
      this.lastError = message;
      this.stateAuthority.emit(scopeId);
    },
  );
  private readonly network = new BrowserNetworkCollector(
    (webContentsId, entry) => {
      const tab = [...this.tabs.values()].find((t) => t.webContents.id === webContentsId);
      if (!tab) return;
      // Read on demand by automation; the renderer's snapshot never carries it.
      pushBounded(tab.networkEntries, { ...entry, tabId: tab.metadata.id }, MAX_NETWORK_PER_TAB);
    },
    (id) =>
      [...this.tabs.values()].find((tab) => tab.webContents.id === id)?.automationAccess !== "user",
  );
  private readonly siteController = new BrowserSiteController({
    send: (channel, payload) => sendToWindow(this.getMainWindow(), channel, payload),
    reportError: (message) => {
      this.lastError = message;
    },
  });
  readonly site = new BrowserSiteApi(this.siteController, (tabId) => this.requireTab(tabId));
  readonly automation = new BrowserAutomationAuthority(this.tabs, (scopeId) =>
    this.automationState(scopeId),
  );
  readonly inspection = new BrowserInspectionController(
    (tabId) => this.requireTab(tabId),
    (tab) => this.responsive.inputScaleGuard(tab),
  );
  readonly page = new BrowserPageController(
    this.tabs,
    (tabId) => this.requireTab(tabId),
    (scopeId) => this.stateAuthority.emit(scopeId),
    (result) => sendToWindow(this.getMainWindow(), "browser:find-result", result),
    (tab) => this.responsive.syncZoom(tab),
  );

  private readonly getMainWindow: () => BrowserWindow | null;
  constructor(
    getMainWindow: () => BrowserWindow | null,
    sessionStore = new BrowserTabSessionStore(),
  ) {
    this.getMainWindow = getMainWindow;
    this.workspace = new BrowserTabWorkspaceController(sessionStore, (message, scopeId) => {
      this.lastError = message;
      this.stateAuthority.emit(scopeId);
    });
    this.stateAuthority = new BrowserManagerState(
      this.tabs,
      this.scopes,
      this.workspace,
      () => this.lastError,
      () => this.getMainWindow(),
    );
    this.responsive = this.createResponsiveController();
    this.downloads = createBrowserDownloadManager({
      lifecycle: this.tabLifecycle,
      getWindow: () => this.getMainWindow(),
      reportError: (message, scopeId) => {
        this.lastError = message;
        this.stateAuthority.emit(scopeId);
      },
    });
    this.popup = new BrowserPopupController({
      getWindow: () => this.getMainWindow(),
      currentUrl: (tabId) => this.tabs.get(tabId)?.webContents.getURL() ?? null,
      assertCanCreateNative: (parent, temporary) =>
        this.creator.assertCanCreateNative(parent, temporary),
      createNativeChild: (parent, details, options, background, temporary) =>
        this.creator.createNativeChild(parent, details, options, background, temporary),
      reportError: (error, scopeId) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.stateAuthority.emit(scopeId);
      },
    });
    this.creator = new BrowserTabCreationController({
      tabs: this.tabs,
      workspace: this.workspace,
      lifecycle: this.tabLifecycle,
      closer: this.tabCloser,
      network: this.network,
      focusGuard: this.focusGuard,
      downloads: this.downloads,
      site: this.siteController,
      library: this.library,
      page: this.page,
      popup: this.popup,
      responsive: this.responsive,
      host: {
        getWindow: () => this.getMainWindow(),
        setLastError: (message) => {
          this.lastError = message;
        },
        emitState: (scopeId) => this.stateAuthority.emit(scopeId),
        emitCounts: () => this.stateAuthority.emitCounts(),
        emitShortcut: (shortcut) => this.stateAuthority.emitShortcut(shortcut),
        activate: (tabId) => this.activateLiveTab(tabId),
        activateFallback: (tabId) => this.activateTab(tabId),
        activeTabId: (scopeId) => this.scopes.activeTabId(scopeId),
        navigate: (tabId, url) => this.navigate(tabId, url),
        inspectElement: (tabId, x, y) =>
          inspectTabElement(this.requireTab(tabId), x, y, () => this.toggleDevTools(tabId)),
        persist: (scopeId) => this.persistScope(scopeId),
      },
    });
    this.organization = new BrowserTabOrganizationController(
      this.tabs,
      this.scopes,
      this.workspace,
      this.tabCloser,
      {
        activate: (tabId) => this.activateTab(tabId),
        create: (source, profile, metadata) =>
          this.creator.create(
            source.url,
            source.sessionProfileId,
            profile,
            source.scopeId,
            "user",
            metadata,
          ),
        persist: (scopeId) => this.persistScope(scopeId),
        emitCounts: () => this.stateAuthority.emitCounts(),
        applyLayout: () => this.applyLayout(),
        emitState: (scopeId) => this.stateAuthority.emit(scopeId),
        state: (scopeId) => this.state(scopeId),
      },
    );
    this.opener = new BrowserOpenController(this.automation, this.inspection, {
      activeTabId: (scopeId) => this.scopes.activeTabId(scopeId),
      navigate: (tabId, url) => this.navigate(tabId, url),
      createAgentTab: (url, scopeId) =>
        this.creator.create(url, "fresh", profileFromSelection("fresh"), scopeId, "agent"),
      requireTab: (tabId) => this.requireTab(tabId),
    });
  }
  private createResponsiveController(): BrowserResponsiveController {
    return new BrowserResponsiveController({
      applyLayout: () => this.applyLayout(),
      emitState: (scopeId) => this.stateAuthority.emit(scopeId),
      reportError: (error, scopeId) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.stateAuthority.emit(scopeId);
      },
      nativeScale: (tab, request) => responsiveNativeScale(this.layout, this.scopes, tab, request),
    });
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
    await this.workspace.ensureRestored(scopeId, this.scopes.activeTabId(scopeId));
    return this.state(scopeId);
  }
  navigate(tabId: string, rawUrl: string): BrowserTabMetadata {
    const tab = this.requireTab(tabId);
    const url = normalizeBrowserOpenUrl(rawUrl);
    tab.metadata = { ...tab.metadata, url };
    this.lastError = null;
    this.page.invalidateFind(tab);
    this.stateAuthority.emit(tab.metadata.scopeId);
    if (tab.profile.mode === "persistent" && tab.automationAccess !== "agent") {
      this.persistScope(tab.metadata.scopeId);
    }
    void tab.webContents.loadURL(url).catch((error: unknown) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.stateAuthority.emit(tab.metadata.scopeId);
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
        this.lastError = error instanceof Error ? error.message : String(error);
        this.stateAuthority.emit(metadata.scopeId);
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
    this.layout.apply(this.tabs, this.scopes.active, this.scopes.bounds, this.scopes.rendererZoom);
  }

  readonly closeTab = (tabId: string): Promise<BrowserStateSnapshot> =>
    this.organization.close(tabId);
  async closeTabsForScope(scopeId: number): Promise<BrowserStateSnapshot> {
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
    await this.workspace.prepareForWindowClose(this.tabs, this.scopes.active);
    this.layout.detachAll();
    this.scopes.clearBounds();
  }
  async prepareForShutdown(): Promise<void> {
    await prepareBrowserShutdown(this.downloads, () =>
      this.workspace.prepareForShutdown(this.tabs, this.scopes.active),
    );
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

  async openUrl(url: string, options: BrowserOpenUrlOptions = {}): Promise<BrowserTabMetadata> {
    return this.opener.open(url, options);
  }

  async openExternalUrl(
    url: string,
    options: BrowserOpenUrlOptions = {},
  ): Promise<BrowserTabMetadata> {
    return this.opener.openExternal(url, options);
  }

  readonly click = (tabId: string, x: number, y: number): Promise<void> =>
    this.inspection.click(tabId, x, y);

  readonly state = (scopeId?: number | null): BrowserStateSnapshot =>
    this.stateAuthority.snapshot(scopeId);

  /** Unfiltered: automation goes through `automation.state`, which applies its policy. */
  readonly automationState = (scopeId?: number | null): BrowserAutomationState =>
    this.stateAuthority.automationSnapshot(scopeId);

  private persistScope(scopeId: number | null): void {
    if (scopeId === null) return;
    this.workspace.schedulePersistence(scopeId, this.tabs, this.scopes.activeTabId(scopeId));
  }

  private requireTab(tabId: string): ManagedTab {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`Unknown browser tab: ${tabId}`);
    return tab;
  }
}
