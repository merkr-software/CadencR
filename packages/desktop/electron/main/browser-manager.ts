import { randomUUID } from "node:crypto";
import { BrowserWindow, WebContentsView } from "electron";
import { normalizeBrowserOpenUrl } from "./browser-policy";
import type { BrowserDomOutline, BrowserDomSnapshot, BrowserEvalResult } from "./browser-dom";
import {
  clearCommentBadges,
  removeCommentBadge,
  selectElementContext,
} from "./browser-comment-context";
import { BrowserFocusGuard } from "./browser-focus-guard";
import {
  clickPage,
  clickTargetPage,
  evaluatePage,
  fillPage,
  hoverPage,
  keypressPage,
  screenshotPage,
  screenshotTargetPage,
  snapshotPage,
  typeTextPage,
  waitForPage,
} from "./browser-page-actions";
import {
  waitForLoad,
  type BrowserTarget,
  type BrowserWaitResult,
  type ResolvedTarget,
} from "./browser-interactions";
import { BrowserNetworkCollector } from "./browser-network-collector";
import { BrowserOriginStore } from "./browser-origin-store";
import { installTabEvents, type ManagedTab } from "./browser-tab-events";
import { BrowserScopeState } from "./browser-scope-state";
import { contentOffset, scaleBounds, windowRelativeBounds } from "./browser-manager-layout";
import { BrowserViewLayout } from "./browser-view-layout";
import {
  metadataFor,
  originOf,
  profileFromSelection,
  pushBounded,
  reclaimFocusForShortcut,
  secureWebPreferences,
  zoomWebContents,
} from "./browser-manager-utils";
import { createBrowserProfile } from "./browser-profiles";
import { sendToWindow } from "./safe-send";
import type {
  BrowserBounds,
  BrowserElementContext,
  BrowserOpenUrlOptions,
  BrowserShortcut,
  BrowserStateSnapshot,
  BrowserTabMetadata,
} from "./browser-types";

const MAX_NETWORK_PER_TAB = 2000;

export class BrowserManager {
  private readonly tabs = new Map<string, ManagedTab>();
  private lastTabCountsByScope: Record<number, number> = {};
  // Per-feature-scope active-tab + viewport-bounds bookkeeping. Tabs are
  // isolated by scope so a tab opened in one feature's Browser never leaks into
  // another's.
  private readonly scopes = new BrowserScopeState();
  private lastError: string | null = null;
  // Keeps a guest page from stealing the agent prompt's focus while the agent
  // drives the browser; `focusGuard.run` wraps each MCP tool dispatch (index.ts).
  readonly focusGuard = new BrowserFocusGuard(() => this.getMainWindow());
  // Native-view attachment + geometry (incl. overlay suppression) lives here.
  private readonly layout = new BrowserViewLayout(() => this.getMainWindow());
  private readonly origins = new BrowserOriginStore();
  private readonly network = new BrowserNetworkCollector((webContentsId, entry) => {
    const tab = [...this.tabs.values()].find((t) => t.view.webContents.id === webContentsId);
    if (!tab) return;
    pushBounded(tab.networkEntries, { ...entry, tabId: tab.metadata.id }, MAX_NETWORK_PER_TAB);
    this.emitState(tab.metadata.scopeId);
  });

  constructor(private readonly getMainWindow: () => BrowserWindow | null) {}

  createTab(
    rawUrl?: string,
    profileId = "fresh",
    scopeId: number | null = null,
  ): BrowserTabMetadata {
    const id = randomUUID();
    const profile = profileFromSelection(profileId);
    const view = new WebContentsView({
      webPreferences: secureWebPreferences(profile),
    });
    const tab: ManagedTab = {
      metadata: metadataFor(id, profileId, scopeId),
      view,
      devtoolsView: null,
      consoleEntries: [],
      networkEntries: [],
      externalAutomationOrigin: null,
    };
    this.tabs.set(id, tab);
    this.emitTabCountsIfChanged();
    installTabEvents(tab, {
      // Every tab event belongs to this tab's scope, so its state push targets
      // that scope alone.
      emitState: () => this.emitState(scopeId),
      setLastError: (message) => {
        this.lastError = message;
      },
      // A child window/tab spawned by this page inherits its feature scope.
      openChildTab: (url, childProfileId) => this.openChildTab(url, childProfileId, scopeId),
      recordOrigin: (url) => this.origins.record(url),
      emitShortcut: (shortcut) => this.emitShortcut(shortcut),
      emitCommentBadgeClick: (id, anchorId, box) =>
        sendToWindow(this.getMainWindow(), "browser:comment-badge-click", {
          tabId: id,
          anchorId,
          box,
        }),
    });
    this.network.ensure(view.webContents.session);
    this.focusGuard.watch(view.webContents);
    this.activateTab(id);
    if (rawUrl) this.navigate(id, rawUrl);
    this.emitState(scopeId);
    return tab.metadata;
  }

  listTabs(scopeId?: number | null): BrowserTabMetadata[] {
    return this.state(scopeId).tabs;
  }

  tabCountsByScope(): Record<number, number> {
    const counts: Record<number, number> = {};
    for (const tab of this.tabs.values()) {
      const scope = tab.metadata.scopeId;
      if (scope === null) continue;
      counts[scope] = (counts[scope] ?? 0) + 1;
    }
    return counts;
  }

  navigate(tabId: string, rawUrl: string): BrowserTabMetadata {
    const tab = this.requireTab(tabId);
    const url = normalizeBrowserOpenUrl(rawUrl);
    this.lastError = null;
    this.emitState(tab.metadata.scopeId);
    void tab.view.webContents.loadURL(url).catch((error: unknown) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.emitState(tab.metadata.scopeId);
    });
    return tab.metadata;
  }

  activateTab(tabId: string): BrowserTabMetadata {
    const tab = this.requireTab(tabId);
    this.scopes.activate(tab.metadata.scopeId, tabId);
    this.scopes.refreshActiveFlags(this.tabs);
    this.applyLayout();
    this.emitState(tab.metadata.scopeId);
    return tab.metadata;
  }

  /**
   * Hide (or restore) every native view. Called when a renderer overlay opens
   * so React dialogs/popovers aren't painted under the always-on-top guest
   * page. Idempotent.
   */
  setSuppressed(value: boolean): void {
    if (this.layout.setSuppressed(value)) this.applyLayout();
  }

  private applyLayout(): void {
    this.layout.apply(this.tabs, this.scopes.active, this.scopes.bounds);
  }

  /** Detach and destroy a tab's native views, then drop it from the map. The
   *  caller handles scope promotion and emitting counts/layout/state. */
  private destroyTab(tab: ManagedTab): void {
    this.layout.detach(tab.view);
    if (tab.devtoolsView) this.layout.detach(tab.devtoolsView);
    tab.view.webContents.close();
    this.tabs.delete(tab.metadata.id);
  }

  closeTab(tabId: string): BrowserStateSnapshot {
    const tab = this.requireTab(tabId);
    const scope = tab.metadata.scopeId;
    this.destroyTab(tab);
    this.emitTabCountsIfChanged();
    // Closing a scope's active tab promotes the next tab *in the same scope*,
    // so closing a tab never reveals another feature's tab.
    const next = this.scopes.forget(scope, tabId, this.tabs);
    if (next) {
      this.activateTab(next);
      return this.state(scope);
    }
    this.scopes.refreshActiveFlags(this.tabs);
    this.applyLayout();
    this.emitState(scope);
    return this.state(scope);
  }

  /**
   * Close every tab belonging to a feature scope in one pass. Used by the
   * sidebar "Close terminals & browsers" action so the user can tear down a
   * feature's browsers without entering it. Destroys all of the scope's tabs
   * first, then emits counts/layout/state once — going through `closeTab`
   * per tab would promote (and re-render) intermediate tabs we're about to
   * destroy anyway. Returns the (now empty) snapshot for that scope.
   */
  closeTabsForScope(scopeId: number): BrowserStateSnapshot {
    const tabs = [...this.tabs.values()].filter((tab) => tab.metadata.scopeId === scopeId);
    for (const tab of tabs) {
      this.destroyTab(tab);
      this.scopes.forget(scopeId, tab.metadata.id, this.tabs);
    }
    this.emitTabCountsIfChanged();
    this.scopes.refreshActiveFlags(this.tabs);
    this.applyLayout();
    this.emitState(scopeId);
    return this.state(scopeId);
  }

  setBounds(
    bounds: BrowserBounds,
    scopeId: number | null = null,
    zoomFactor?: number,
  ): BrowserStateSnapshot {
    const win = this.getMainWindow();
    // Prefer the renderer-supplied zoom factor: it was read in the same process
    // and instant as the getBoundingClientRect measurement, so bounds and factor
    // always agree. Reading our own getZoomFactor() races with zoom propagation
    // and mis-places the view toward the origin until the next zoom change.
    const factor = zoomFactor ?? win?.webContents.getZoomFactor() ?? 1;
    this.scopes.setBounds(
      scopeId,
      windowRelativeBounds(scaleBounds(bounds, factor), contentOffset(win)),
    );
    this.applyLayout();
    return this.state(scopeId);
  }

  goBack(tabId: string): void {
    const contents = this.requireTab(tabId).view.webContents;
    if (contents.canGoBack()) contents.goBack();
  }

  goForward(tabId: string): void {
    const contents = this.requireTab(tabId).view.webContents;
    if (contents.canGoForward()) contents.goForward();
  }

  reload(tabId: string): void {
    this.requireTab(tabId).view.webContents.reload();
  }

  stop(tabId: string): void {
    this.requireTab(tabId).view.webContents.stop();
  }

  zoomIn(tabId: string): void {
    zoomWebContents(this.requireTab(tabId).view.webContents, "in");
  }

  zoomOut(tabId: string): void {
    zoomWebContents(this.requireTab(tabId).view.webContents, "out");
  }

  toggleDevTools(tabId: string): BrowserTabMetadata {
    const tab = this.requireTab(tabId);
    if (!tab.devtoolsView) {
      tab.devtoolsView = new WebContentsView({
        webPreferences: secureWebPreferences(createBrowserProfile("fresh")),
      });
      tab.view.webContents.setDevToolsWebContents(tab.devtoolsView.webContents);
    }
    const open = !tab.metadata.devToolsOpen;
    tab.metadata = { ...tab.metadata, devToolsOpen: open };
    this.applyLayout();
    if (open) tab.view.webContents.openDevTools({ mode: "detach" });
    else tab.view.webContents.closeDevTools();
    this.emitState(tab.metadata.scopeId);
    return tab.metadata;
  }

  async openUrl(url: string, options: BrowserOpenUrlOptions = {}): Promise<BrowserTabMetadata> {
    const scopeId = options.scopeId ?? null;
    const targetTabId =
      options.tabId ?? (options.newTab === true ? null : this.scopes.activeTabId(scopeId));
    const meta = targetTabId
      ? this.navigate(targetTabId, url)
      : this.createTab(url, "fresh", scopeId);
    await waitForLoad(this.requireTab(meta.id).view.webContents);
    return this.requireTab(meta.id).metadata;
  }

  // Permission-gated external opener (browser_open_external_url). Opens any web
  // URL and unlocks automation for the resulting origin only; if the tab later
  // navigates to a different origin it re-locks (see assertMutatingAllowed).
  async openExternalUrl(
    url: string,
    options: BrowserOpenUrlOptions = {},
  ): Promise<BrowserTabMetadata> {
    const meta = await this.openUrl(url, options);
    const tab = this.requireTab(meta.id);
    tab.externalAutomationOrigin = originOf(tab.view.webContents.getURL());
    return tab.metadata;
  }

  async snapshot(
    tabId: string,
    selector?: string,
    maxLength?: number,
    format?: string,
  ): Promise<BrowserDomSnapshot | BrowserDomOutline> {
    return snapshotPage(this.requireTab(tabId), selector, maxLength, format);
  }

  async screenshot(tabId: string, clip?: BrowserBounds): Promise<string> {
    return screenshotPage(this.requireTab(tabId), clip);
  }

  async screenshotTarget(tabId: string, target: BrowserTarget): Promise<string> {
    return screenshotTargetPage(this.requireTab(tabId), target);
  }

  async evaluate(tabId: string, script: string): Promise<BrowserEvalResult> {
    return evaluatePage(this.requireTab(tabId), script);
  }

  async click(tabId: string, x: number, y: number): Promise<void> {
    clickPage(this.requireTab(tabId), x, y);
  }

  async typeText(tabId: string, text: string): Promise<void> {
    typeTextPage(this.requireTab(tabId), text);
  }

  async keypress(tabId: string, keyCode: string): Promise<void> {
    keypressPage(this.requireTab(tabId), keyCode);
  }

  async clickTarget(tabId: string, target: BrowserTarget): Promise<ResolvedTarget> {
    return clickTargetPage(this.requireTab(tabId), target);
  }

  async hover(tabId: string, target: BrowserTarget): Promise<ResolvedTarget> {
    return hoverPage(this.requireTab(tabId), target);
  }

  async fill(tabId: string, target: BrowserTarget, value: string): Promise<void> {
    return fillPage(this.requireTab(tabId), target, value);
  }

  async waitFor(
    tabId: string,
    opts: { selector?: string; text?: string },
    timeoutMs?: number,
  ): Promise<BrowserWaitResult> {
    return waitForPage(this.requireTab(tabId), opts, timeoutMs);
  }

  selectElementContext(tabId: string, anchorId?: string): Promise<BrowserElementContext> {
    return selectElementContext(this.requireTab(tabId), anchorId);
  }

  removeCommentBadge(tabId: string, anchorId: string): Promise<void> {
    return removeCommentBadge(this.requireTab(tabId), anchorId);
  }

  clearCommentBadges(tabId: string): Promise<void> {
    return clearCommentBadges(this.requireTab(tabId));
  }

  // See `BrowserScopeState.snapshot` for the scoped vs unscoped (agent/MCP) view.
  state(scopeId?: number | null): BrowserStateSnapshot {
    return this.scopes.snapshot(scopeId, this.tabs, this.origins.list(), this.lastError);
  }

  private openChildTab(url: string, profileId: string, scopeId: number | null): void {
    try {
      this.createTab(url, profileId, scopeId);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.emitState(scopeId);
    }
  }

  private requireTab(tabId: string): ManagedTab {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`Unknown browser tab: ${tabId}`);
    return tab;
  }

  /**
   * Push the snapshot for the one scope an operation changed. Browser state is
   * isolated per feature scope, so an event only ever affects its own scope's
   * snapshot — broadcasting to all of them would just be discarded by the rest.
   * Scopeless (agent/MCP) tabs have no UI workspace, so they aren't broadcast.
   */
  private emitState(scope: number | null): void {
    const win = this.getMainWindow();
    if (scope === null) return;
    sendToWindow(win, "browser:state", this.state(scope));
  }

  private emitTabCountsIfChanged(): void {
    const counts = this.tabCountsByScope();
    if (tabCountRecordsEqual(this.lastTabCountsByScope, counts)) return;
    this.lastTabCountsByScope = counts;
    sendToWindow(this.getMainWindow(), "browser:tab-counts", counts);
  }

  private emitShortcut(shortcut: BrowserShortcut): void {
    const win = this.getMainWindow();
    reclaimFocusForShortcut(win, shortcut);
    sendToWindow(win, "browser:shortcut", shortcut);
  }
}

function tabCountRecordsEqual(a: Record<number, number>, b: Record<number, number>): boolean {
  const leftKeys = Object.keys(a);
  const rightKeys = Object.keys(b);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => a[Number(key)] === b[Number(key)])
  );
}
