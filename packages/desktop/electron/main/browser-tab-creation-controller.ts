import type { BrowserWindow, HandlerDetails, WebContents } from "electron";
import { normalizeBrowserOpenUrl } from "./browser-policy";
import { isPinnedCommentBadge } from "./browser-comment-context";
import { installBrowserContextMenu } from "./browser-context-menu";
import type { BrowserFocusGuard } from "./browser-focus-guard";
import type { BrowserDownloadManager } from "./browser-download-manager";
import type { BrowserLibraryController } from "./browser-library-controller";
import { reclaimRendererFocus } from "./browser-manager-utils";
import type { BrowserNetworkCollector } from "./browser-network-collector";
import type { BrowserPageController } from "./browser-page-controller";
import type { BrowserProfile } from "./browser-profiles";
import type { BrowserPopupController } from "./browser-popup-controller";
import type { BrowserResponsiveController } from "./browser-responsive-controller";
import type { BrowserSiteController } from "./browser-site-controller";
import type { BrowserTabCloseController } from "./browser-tab-close-controller";
import { installTabEvents, type ManagedTab } from "./browser-tab-events";
import type { BrowserTabLifecycle } from "./browser-tab-lifecycle";
import type { BrowserTabWorkspaceController } from "./browser-tab-workspace-controller";
import type { BrowserAgentAccess, BrowserShortcut, BrowserTabMetadata } from "./browser-types";
import { sendToWindow } from "./safe-send";

interface BrowserTabCreationHost {
  getWindow(): BrowserWindow | null;
  setLastError(message: string | null): void;
  emitState(scopeId: number | null): void;
  emitCounts(): void;
  emitShortcut(shortcut: BrowserShortcut): void;
  activate(tabId: string): BrowserTabMetadata;
  activateFallback(tabId: string): Promise<BrowserTabMetadata>;
  activeTabId(scopeId: number | null): string | null;
  navigate(tabId: string, url: string): BrowserTabMetadata;
  inspectElement(tabId: string, x: number, y: number): void;
  persist(scopeId: number | null): void;
}

interface BrowserTabCreationOptions {
  tabs: Map<string, ManagedTab>;
  workspace: BrowserTabWorkspaceController;
  lifecycle: BrowserTabLifecycle;
  closer: BrowserTabCloseController;
  network: BrowserNetworkCollector;
  focusGuard: BrowserFocusGuard;
  downloads: BrowserDownloadManager;
  site: BrowserSiteController;
  library: BrowserLibraryController;
  page: BrowserPageController;
  popup: BrowserPopupController;
  responsive: BrowserResponsiveController;
  host: BrowserTabCreationHost;
}

/** Creates and wires live tabs, including lazy-restored and child tabs. */
export class BrowserTabCreationController {
  constructor(private readonly options: BrowserTabCreationOptions) {}

  create(
    rawUrl: string | undefined,
    selectionId: string,
    profile: BrowserProfile,
    scopeId: number | null,
    automationAccess: BrowserAgentAccess = "user",
    restoredMetadata?: BrowserTabMetadata,
    reuseOrder = false,
  ): BrowserTabMetadata {
    const { tabs, workspace, lifecycle, host } = this.options;
    const normalizedUrl = rawUrl ? normalizeBrowserOpenUrl(rawUrl) : undefined;
    if (!reuseOrder) workspace.assertCanCreate(scopeId, profile.mode, automationAccess, tabs);
    const tab = lifecycle.create(selectionId, profile, scopeId, automationAccess, restoredMetadata);
    this.register(tab, profile, reuseOrder, true);
    if (normalizedUrl) host.navigate(tab.metadata.id, normalizedUrl);
    return tab.metadata;
  }

  createNativeChild(
    parent: ManagedTab,
    details: HandlerDetails,
    nativeOptions: Electron.BrowserWindowConstructorOptions,
    background: boolean,
    temporary: boolean,
  ): WebContents {
    const { workspace, lifecycle } = this.options;
    if (!temporary) {
      workspace.assertCanCreate(
        parent.metadata.scopeId,
        parent.profile.mode,
        parent.automationAccess,
        this.options.tabs,
      );
    }
    const tab = lifecycle.create(
      parent.metadata.sessionProfileId,
      parent.profile,
      parent.metadata.scopeId,
      parent.automationAccess,
      undefined,
      {
        webContents: nativeChildWebContents(nativeOptions),
        webPreferences: nativeOptions.webPreferences,
      },
      temporary,
      parent.webContents.session,
    );
    tab.metadata = {
      ...tab.metadata,
      url: details.url,
      title: details.frameName && details.frameName !== "_blank" ? details.frameName : details.url,
    };
    tab.openerTabId = temporary ? parent.metadata.id : null;
    this.register(tab, parent.profile, false, !background);
    if (temporary) {
      const closeWithParent = (): void => {
        if (tab.temporary && !tab.webContents.isDestroyed()) {
          tab.webContents.close({ waitForBeforeUnload: false });
        }
      };
      const focusFromOpener = (): void => {
        if (
          this.options.tabs.has(parent.metadata.id) &&
          this.options.tabs.has(tab.metadata.id) &&
          this.options.popup.consumeFocusGesture(parent)
        ) {
          this.options.host.activate(tab.metadata.id);
        }
      };
      let attached = true;
      const detach = (): void => {
        if (!attached) return;
        attached = false;
        parent.webContents.off("destroyed", closeWithParent);
        tab.webContents.off("focus", focusFromOpener);
        tab.detachOpenerRelations = null;
      };
      parent.webContents.once("destroyed", closeWithParent);
      tab.webContents.on("focus", focusFromOpener);
      tab.webContents.once("destroyed", detach);
      tab.detachOpenerRelations = detach;
    }
    if (background && !nativeChildWebContents(nativeOptions)) {
      void tab.webContents
        .loadURL(details.url, nativeLoadOptions(details))
        .catch((error: unknown) => {
          this.options.host.setLastError(error instanceof Error ? error.message : String(error));
          this.options.host.emitState(tab.metadata.scopeId);
        });
    }
    return tab.webContents;
  }

  assertCanCreateNative(parent: ManagedTab, temporary: boolean): void {
    if (temporary) return;
    this.options.workspace.assertCanCreate(
      parent.metadata.scopeId,
      parent.profile.mode,
      parent.automationAccess,
      this.options.tabs,
    );
  }

  promoteTemporaryForChrome(tab: ManagedTab): void {
    if (!tab.temporary) return;
    this.options.workspace.assertCanCreate(
      tab.metadata.scopeId,
      tab.profile.mode,
      tab.automationAccess,
      this.options.tabs,
    );
    tab.temporary = false;
    tab.metadata = { ...tab.metadata, temporary: undefined };
    tab.detachOpenerRelations?.();
    tab.openerTabId = null;
  }

  private register(
    tab: ManagedTab,
    profile: BrowserProfile,
    reuseOrder: boolean,
    activate: boolean,
  ): BrowserTabMetadata {
    const { workspace, lifecycle, host } = this.options;
    try {
      this.installEvents(tab, profile);
      this.options.popup.watch(tab);
      this.options.responsive.watch(tab);
      this.options.network.ensure(tab.webContents.session);
      this.options.focusGuard.watch(tab.webContents);
      lifecycle.register(tab);
      this.options.downloads.watch(tab);
      this.options.site.registerTab(tab);
      workspace.register(tab, reuseOrder);
      host.emitCounts();
      if (activate) host.activate(tab.metadata.id);
      else host.emitState(tab.metadata.scopeId);
      if (profile.mode === "persistent" && tab.automationAccess !== "agent" && !tab.temporary) {
        host.persist(tab.metadata.scopeId);
      }
      return tab.metadata;
    } catch (error) {
      workspace.rollbackRegistration(tab, reuseOrder);
      this.options.closer.discardFailed(tab, error);
      throw error;
    }
  }

  private installEvents(tab: ManagedTab, profile: BrowserProfile): void {
    const { tabs, host, library, page } = this.options;
    const id = tab.metadata.id;
    installBrowserContextMenu(tab.webContents, host.getWindow, {
      openLinkInNewTab: (url) => {
        this.create(
          url,
          tab.metadata.sessionProfileId,
          profile,
          tab.metadata.scopeId,
          tab.automationAccess,
        );
      },
      inspectElement: (x, y) => host.inspectElement(id, x, y),
      reportError: (error) => {
        host.setLastError(error instanceof Error ? error.message : String(error));
        host.emitState(tab.metadata.scopeId);
      },
    });
    installTabEvents(tab, {
      emitState: () => host.emitState(tab.metadata.scopeId),
      setLastError: (message) => host.setLastError(message),
      isTabAlive: () => tabs.has(id),
      tabDestroyed: () => this.handleNativeDestroyed(tab),
      recordHistoryNavigation: (url, title) => {
        if (!tab.temporary) library.recordNavigation(tab, url, title);
      },
      updateHistoryTitle: (url, title) => {
        if (!tab.temporary) library.updateTitle(tab, url, title);
      },
      forgetHistory: () => library.forget(id),
      emitShortcut: host.emitShortcut,
      matchGuestShortcut: (input) => page.matchGuestShortcut(input),
      emitFindResult: (result) => page.handleFindResult(tab, result),
      invalidateFind: () => page.invalidateFind(tab),
      syncZoom: () => page.syncZoom(),
      persistTab: () => {
        if (!tab.temporary) host.persist(tab.metadata.scopeId);
      },
      emitCommentBadgeClick: (tabId, anchorId, box) => {
        // The badge click landed in the guest view; give the renderer keyboard
        // focus so the reopened comment composer takes typing — but only for a
        // badge we pinned, since any page can print the sentinel line.
        if (isPinnedCommentBadge(tab, anchorId)) reclaimRendererFocus(host.getWindow());
        sendToWindow(host.getWindow(), "browser:comment-badge-click", { tabId, anchorId, box });
      },
    });
  }

  private handleNativeDestroyed(tab: ManagedTab): void {
    const { tabs, workspace, closer, host } = this.options;
    if (!tabs.has(tab.metadata.id)) return;
    const removal = workspace.remove(tab.metadata.id, tabs, false);
    const wasActive = host.activeTabId(tab.metadata.scopeId) === tab.metadata.id;
    const opener = tab.openerTabId ? tabs.get(tab.openerTabId) : null;
    const fallbackId = wasActive
      ? opener?.metadata.scopeId === tab.metadata.scopeId
        ? opener.metadata.id
        : removal?.nextId
      : null;
    if (fallbackId) {
      void host.activateFallback(fallbackId).catch((error: unknown) => {
        host.setLastError(error instanceof Error ? error.message : String(error));
        host.emitState(tab.metadata.scopeId);
      });
    }
    closer.handleNativeDestroyed(tab);
    if (tab.metadata.scopeId !== null && tab.profile.mode === "persistent" && !tab.temporary) {
      host.persist(tab.metadata.scopeId);
    }
  }
}

function nativeChildWebContents(
  options: Electron.BrowserWindowConstructorOptions,
): WebContents | undefined {
  return (
    options as Electron.BrowserWindowConstructorOptions & {
      webContents?: WebContents;
    }
  ).webContents;
}

function nativeLoadOptions(details: HandlerDetails): Electron.LoadURLOptions {
  const postBody = details.postBody;
  const contentType = postBody
    ? `${postBody.contentType}${postBody.boundary ? `; boundary=${postBody.boundary}` : ""}`
    : null;
  return {
    httpReferrer: details.referrer,
    postData: postBody?.data,
    extraHeaders: contentType ? `Content-Type: ${contentType}` : undefined,
  };
}
