import type { Input, Result } from "electron";

import { BrowserFindController } from "./browser-find-controller";
import { shortcutPlatform } from "./browser-guest-shortcuts";
import type { ManagedTab } from "./browser-tab-events";
import type {
  BrowserFindRequest,
  BrowserFindResult,
  BrowserGuestShortcutBindings,
} from "./browser-types";
import { BrowserZoomController } from "./browser-zoom-controller";
import {
  compileBrowserShortcutBinding,
  type BrowserShortcutInputMatcher,
} from "../../src/lib/shortcuts/match-browser-input";
import type { BrowserShortcut } from "./browser-types";

export interface BrowserPageControllerOptions {
  tabs: Map<string, ManagedTab>;
  requireTab: (tabId: string) => ManagedTab;
  emitState: (scopeId: number | null) => void;
  emitFindResult: (result: BrowserFindResult) => void;
  syncResponsive?: (tab: ManagedTab) => void;
  clearTabError?: (tab: ManagedTab) => void;
  retryFailedLoad?: (tab: ManagedTab) => boolean;
}

/** User-facing navigation, find, and zoom controls for native guest pages. */
export class BrowserPageController {
  private findShortcutMatcher: BrowserShortcutInputMatcher = () => false;
  private downloadsShortcutMatcher: BrowserShortcutInputMatcher = () => false;
  private responsiveShortcutMatcher: BrowserShortcutInputMatcher = () => false;
  private devtoolsShortcutMatcher: BrowserShortcutInputMatcher = () => false;
  private zoomResetShortcutMatcher: BrowserShortcutInputMatcher = () => false;
  private navigateBackShortcutMatcher: BrowserShortcutInputMatcher = () => false;
  private navigateForwardShortcutMatcher: BrowserShortcutInputMatcher = () => false;
  private readonly tabs: Map<string, ManagedTab>;
  private readonly requireTab: (tabId: string) => ManagedTab;
  private readonly clearTabError: (tab: ManagedTab) => void;
  private readonly retryFailedLoad: (tab: ManagedTab) => boolean;
  private readonly findController: BrowserFindController;
  private readonly zoomController: BrowserZoomController;

  constructor(options: BrowserPageControllerOptions) {
    this.tabs = options.tabs;
    this.requireTab = options.requireTab;
    this.clearTabError = options.clearTabError ?? (() => undefined);
    this.retryFailedLoad = options.retryFailedLoad ?? (() => false);
    this.findController = new BrowserFindController(options.emitFindResult);
    this.zoomController = new BrowserZoomController(
      this.tabs,
      options.emitState,
      options.syncResponsive ?? (() => undefined),
    );
  }

  goBack(tabId: string): void {
    const tab = this.requireTab(tabId);
    const contents = tab.webContents;
    if (!contents.canGoBack()) return;
    this.findController.invalidate(tab);
    this.clearTabError(tab);
    contents.goBack();
  }

  goForward(tabId: string): void {
    const tab = this.requireTab(tabId);
    const contents = tab.webContents;
    if (!contents.canGoForward()) return;
    this.findController.invalidate(tab);
    this.clearTabError(tab);
    contents.goForward();
  }

  reload(tabId: string): void {
    const tab = this.requireTab(tabId);
    this.findController.invalidate(tab);
    if (this.retryFailedLoad(tab)) return;
    this.clearTabError(tab);
    tab.webContents.reload();
  }

  stop(tabId: string): void {
    this.requireTab(tabId).webContents.stop();
  }

  zoom(tabId: string, action: "in" | "out" | "reset"): void {
    this.zoomController.apply(this.requireTab(tabId), action);
  }

  syncZoom(): void {
    this.zoomController.sync();
  }

  find(tabId: string, request: BrowserFindRequest): void {
    this.findController.find(this.requireTab(tabId), request);
  }

  handleFindResult(tab: ManagedTab, result: Result): void {
    if (!this.tabs.has(tab.metadata.id)) return;
    this.findController.handleResult(tab, result);
  }

  invalidateFind(tab: ManagedTab): void {
    this.findController.invalidate(tab);
  }

  stopFind(tabId: string, focusPage: boolean): void {
    this.findController.stop(tabId, this.optionalTab(tabId), focusPage);
  }

  setGuestShortcutBindings(bindings: BrowserGuestShortcutBindings): void {
    const platform = shortcutPlatform();
    this.findShortcutMatcher = compileBrowserShortcutBinding(bindings.find, platform);
    this.downloadsShortcutMatcher = compileBrowserShortcutBinding(bindings.downloads, platform);
    this.responsiveShortcutMatcher = compileBrowserShortcutBinding(bindings.responsive, platform);
    this.devtoolsShortcutMatcher = compileBrowserShortcutBinding(bindings.devtools, platform);
    this.zoomResetShortcutMatcher = compileBrowserShortcutBinding(bindings.zoomReset, platform);
    this.navigateBackShortcutMatcher = compileBrowserShortcutBinding(
      bindings.navigateBack,
      platform,
    );
    this.navigateForwardShortcutMatcher = compileBrowserShortcutBinding(
      bindings.navigateForward,
      platform,
    );
  }

  matchGuestShortcut(input: Input): BrowserShortcut | null {
    if (this.findShortcutMatcher(input)) return "find";
    if (this.downloadsShortcutMatcher(input)) return "downloads";
    if (this.responsiveShortcutMatcher(input)) return "responsive";
    if (this.devtoolsShortcutMatcher(input)) return "devtools";
    if (this.zoomResetShortcutMatcher(input)) return "zoom-reset";
    if (this.navigateBackShortcutMatcher(input)) return "navigate-back";
    if (this.navigateForwardShortcutMatcher(input)) return "navigate-forward";
    return null;
  }

  private optionalTab(tabId: string): ManagedTab | undefined {
    // Closing a find bar may race the tab's destruction; clearing the
    // controller token is still useful and there is no guest left to stop.
    return this.tabs.get(tabId);
  }
}
