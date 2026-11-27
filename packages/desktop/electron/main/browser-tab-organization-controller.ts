import { randomUUID } from "node:crypto";
import { DEFAULT_BROWSER_RESPONSIVE_STATE } from "../../src/shared/browser-responsive";
import { translateUi } from "../../src/shared/ui-i18n";
import type { BrowserScopeState } from "./browser-scope-state";
import type { ManagedTab } from "./browser-tab-events";
import type { BrowserTabCloseController } from "./browser-tab-close-controller";
import { unknownBrowserTab } from "./browser-tab-errors";
import type { BrowserTabWorkspaceController } from "./browser-tab-workspace-controller";
import type { RestorableBrowserTab } from "./browser-tab-session-store";
import type { BrowserProfile } from "./browser-profiles";
import { profileFromSelection } from "./browser-manager-utils";
import type { BrowserStateSnapshot, BrowserTabMetadata } from "./browser-types";

interface BrowserTabOrganizationHost {
  activate(tabId: string): Promise<BrowserTabMetadata>;
  create(
    source: { url: string; sessionProfileId: string; scopeId: number | null },
    profile: BrowserProfile,
    metadata: BrowserTabMetadata,
  ): BrowserTabMetadata;
  persist(scopeId: number | null): void;
  emitCounts(): void;
  applyLayout(): void;
  emitState(scopeId: number | null): void;
  state(scopeId: number | null): BrowserStateSnapshot;
}

/** Main-process authority for user tab organization and recoverability actions. */
export class BrowserTabOrganizationController {
  constructor(
    private readonly tabs: Map<string, ManagedTab>,
    private readonly scopes: BrowserScopeState,
    private readonly workspace: BrowserTabWorkspaceController,
    private readonly closer: BrowserTabCloseController,
    private readonly host: BrowserTabOrganizationHost,
  ) {}

  async close(tabId: string): Promise<BrowserStateSnapshot> {
    const live = this.tabs.get(tabId);
    const metadata = live?.metadata ?? this.workspace.dormantTab(tabId)?.metadata;
    if (!metadata) throw unknownBrowserTab(tabId);
    const wasActive = this.scopes.activeTabId(metadata.scopeId) === tabId;
    const removal = this.workspace.remove(tabId, this.tabs, true);
    const cleanup = live ? this.closer.close(live, false) : this.removeDormant(metadata);
    const opener = live?.openerTabId ? this.tabs.get(live.openerTabId) : null;
    const fallbackId =
      opener?.metadata.scopeId === metadata.scopeId ? opener.metadata.id : removal?.nextId;
    const activation = wasActive && fallbackId ? this.host.activate(fallbackId) : Promise.resolve();
    if (shouldPersistRemoval(metadata, live)) this.host.persist(metadata.scopeId);
    const [cleanupResult, activationResult] = await Promise.allSettled([cleanup, activation]);
    throwRejected(cleanupResult, activationResult);
    return this.host.state(metadata.scopeId);
  }

  async closeScope(scopeId: number): Promise<BrowserStateSnapshot> {
    const live = this.workspace.clearScope(scopeId, this.tabs);
    const cleanup = this.closer.closeMany(live, scopeId);
    this.host.persist(scopeId);
    await cleanup;
    return this.host.state(scopeId);
  }

  duplicate(tabId: string): BrowserTabMetadata {
    const live = this.tabs.get(tabId);
    const source = live?.metadata ?? this.workspace.dormantTab(tabId)?.metadata;
    if (!source) throw unknownBrowserTab(tabId);
    if (live?.temporary) {
      throw new Error(
        translateUi(
          "workspace.browser.tab.duplicateTemporary",
          "Temporary sign-in tabs cannot be duplicated or replayed as a GET request.",
        ),
      );
    }
    const profile = live?.profile ?? profileFromSelection(source.sessionProfileId);
    return this.host.create(source, profile, duplicateMetadata(source));
  }

  setPinned(tabId: string, pinned: boolean): BrowserStateSnapshot {
    const metadata = this.metadata(tabId);
    if (this.workspace.setPinned(tabId, pinned, this.tabs)) {
      this.host.persist(metadata.scopeId);
      this.host.emitState(metadata.scopeId);
    }
    return this.host.state(metadata.scopeId);
  }

  reorder(tabId: string, targetIndex: number): BrowserStateSnapshot {
    const metadata = this.metadata(tabId);
    if (this.workspace.reorder(tabId, targetIndex, this.tabs)) {
      this.host.persist(metadata.scopeId);
      this.host.emitState(metadata.scopeId);
    }
    return this.host.state(metadata.scopeId);
  }

  async closeOthers(tabId: string): Promise<BrowserStateSnapshot> {
    const metadata = this.metadata(tabId);
    const closingIds = this.workspace.closeOtherIds(tabId, this.tabs);
    await this.host.activate(tabId);
    const live: ManagedTab[] = [];
    for (const closingId of closingIds) {
      const closing = this.tabs.get(closingId);
      this.workspace.remove(closingId, this.tabs, true);
      if (closing) live.push(closing);
    }
    const cleanup = live.length > 0 ? this.closer.closeMany(live, metadata.scopeId) : null;
    if (!cleanup) this.refresh(metadata.scopeId);
    this.host.persist(metadata.scopeId);
    if (cleanup) await cleanup;
    return this.host.state(metadata.scopeId);
  }

  reopen(scopeId: number): BrowserTabMetadata | null {
    const closed = this.workspace.lastClosed(scopeId);
    if (!closed) return null;
    const tab = this.host.create(
      { ...closed, scopeId },
      profileFromSelection(closed.sessionProfileId),
      restoredMetadata(closed, scopeId),
    );
    this.workspace.consumeClosed(scopeId, closed);
    return tab;
  }

  private metadata(tabId: string): BrowserTabMetadata {
    const metadata = this.tabs.get(tabId)?.metadata ?? this.workspace.dormantTab(tabId)?.metadata;
    if (!metadata) throw unknownBrowserTab(tabId);
    return metadata;
  }

  private removeDormant(metadata: BrowserTabMetadata): Promise<void> {
    this.scopes.forget(metadata.scopeId, metadata.id, this.tabs);
    this.refresh(metadata.scopeId);
    return Promise.resolve();
  }

  private refresh(scopeId: number | null): void {
    this.host.emitCounts();
    this.host.applyLayout();
    this.host.emitState(scopeId);
  }
}

function duplicateMetadata(source: BrowserTabMetadata): BrowserTabMetadata {
  return {
    ...source,
    id: randomUUID(),
    loading: false,
    canGoBack: false,
    canGoForward: false,
    isActive: false,
    devToolsOpen: false,
    pinned: false,
    suspended: false,
    responsive: { ...DEFAULT_BROWSER_RESPONSIVE_STATE },
  };
}

function restoredMetadata(tab: RestorableBrowserTab, scopeId: number): BrowserTabMetadata {
  return {
    id: randomUUID(),
    title: tab.title,
    defaultTitle: tab.defaultTitle,
    url: tab.url,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    sessionProfileId: tab.sessionProfileId,
    isActive: false,
    devToolsOpen: false,
    pinned: tab.pinned,
    suspended: false,
    zoomPercent: 100,
    responsive: { ...DEFAULT_BROWSER_RESPONSIVE_STATE },
    scopeId,
  };
}

function shouldPersistRemoval(metadata: BrowserTabMetadata, live?: ManagedTab): boolean {
  return (
    metadata.scopeId !== null &&
    (!live || (live.profile.mode === "persistent" && live.automationAccess !== "agent")) &&
    live?.temporary !== true
  );
}

function throwRejected(...results: PromiseSettledResult<unknown>[]): void {
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(
      errors,
      translateUi("workspace.browser.tab.closeFailed", "Browser tab close failed"),
    );
}
