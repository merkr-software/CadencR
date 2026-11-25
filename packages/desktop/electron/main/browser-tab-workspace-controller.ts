import { translateUi } from "../../src/shared/ui-i18n";
import { randomUUID } from "node:crypto";
import { DEFAULT_BROWSER_RESPONSIVE_STATE } from "../../src/shared/browser-responsive";
import type { ManagedTab } from "./browser-tab-events";
import { BrowserTabPersistenceController } from "./browser-tab-persistence-controller";
import {
  MAX_RESTORABLE_TABS_PER_SCOPE,
  type RestorableBrowserScope,
  type RestorableBrowserTab,
} from "./browser-tab-session-store";
import type { BrowserTabSessionStore } from "./browser-tab-session-store";
import {
  browserTabErrorMessage,
  insertOrderedTab,
  isPersistableLiveTab,
  isPersistentMetadata,
  pinnedTabCount,
  restorableFromMetadata,
  scopedTabIds,
  scopeTabIds,
  workspaceMetadata,
  type BrowserTabScopeId,
  type DormantBrowserTab,
} from "./browser-tab-workspace-utils";

const MAX_CLOSED_TABS_PER_SCOPE = 25;

/** Owns ordering, lazy restore metadata, closed-tab history, and persistence scheduling. */
export class BrowserTabWorkspaceController {
  private readonly order = new Map<BrowserTabScopeId, string[]>();
  private readonly pinnedIds = new Set<string>();
  private readonly dormant = new Map<string, DormantBrowserTab>();
  private readonly closed = new Map<number, RestorableBrowserTab[]>();
  private readonly restorePromises = new Map<number, Promise<string | null>>();
  private readonly restoredScopes = new Set<number>();
  private readonly lastPersistentActive = new Map<number, string>();
  private readonly persistence: BrowserTabPersistenceController;

  constructor(
    store: BrowserTabSessionStore,
    private readonly reportError: (message: string, scopeId: number) => void,
  ) {
    this.persistence = new BrowserTabPersistenceController(store, reportError);
  }

  ensureRestored(scopeId: number, currentActiveId: string | null): Promise<string | null> {
    if (this.restoredScopes.has(scopeId)) return Promise.resolve(currentActiveId);
    const current = this.restorePromises.get(scopeId);
    if (current) return current.then((restoredId) => currentActiveId ?? restoredId);
    const restoring = this.restore(scopeId, currentActiveId).finally(() => {
      this.restoredScopes.add(scopeId);
      this.restorePromises.delete(scopeId);
    });
    this.restorePromises.set(scopeId, restoring);
    return restoring;
  }

  register(tab: ManagedTab, reuseOrder = false): void {
    tab.metadata = { ...tab.metadata, pinned: tab.metadata.pinned === true, suspended: false };
    if (tab.metadata.pinned) this.pinnedIds.add(tab.metadata.id);
    if (reuseOrder) {
      this.dormant.delete(tab.metadata.id);
      if (!this.order.get(tab.metadata.scopeId)?.includes(tab.metadata.id)) {
        insertOrderedTab(
          this.order,
          this.pinnedIds,
          tab.metadata.scopeId,
          tab.metadata.id,
          tab.metadata.pinned,
        );
      }
      return;
    }
    insertOrderedTab(
      this.order,
      this.pinnedIds,
      tab.metadata.scopeId,
      tab.metadata.id,
      tab.metadata.pinned,
    );
  }

  rollbackRegistration(tab: ManagedTab, reuseOrder: boolean): void {
    const id = tab.metadata.id;
    if (reuseOrder) {
      this.dormant.set(id, { metadata: { ...tab.metadata, isActive: false, suspended: true } });
      if (tab.metadata.pinned) this.pinnedIds.add(id);
      return;
    }
    this.dormant.delete(id);
    this.pinnedIds.delete(id);
    const ids = this.order.get(tab.metadata.scopeId);
    if (!ids) return;
    const index = ids.indexOf(id);
    if (index >= 0) ids.splice(index, 1);
    if (ids.length === 0) this.order.delete(tab.metadata.scopeId);
  }

  assertCanCreate(
    scopeId: BrowserTabScopeId,
    profileMode: ManagedTab["profile"]["mode"],
    automationAccess: ManagedTab["automationAccess"],
    liveTabs: Map<string, ManagedTab>,
  ): void {
    if (
      scopeId === null ||
      profileMode !== "persistent" ||
      automationAccess === "agent" ||
      !this.persistence.isEnabled(scopeId)
    ) {
      return;
    }
    if (this.persistableItems(scopeId, liveTabs).length >= MAX_RESTORABLE_TABS_PER_SCOPE) {
      throw new Error(
        translateUi(
          "workspace.browser.tab.limit",
          "Normal Browser tabs are limited to {{count}} per feature.",
          { count: MAX_RESTORABLE_TABS_PER_SCOPE },
        ),
      );
    }
  }

  dormantTab(tabId: string): DormantBrowserTab | null {
    return this.dormant.get(tabId) ?? null;
  }

  metadata(
    scopeId: number | null | undefined,
    liveTabs: Map<string, ManagedTab>,
    activeId: string | null,
  ) {
    return workspaceMetadata(scopeId, liveTabs, this.dormant, this.order, activeId);
  }

  countByScope(liveTabs: Map<string, ManagedTab>): Record<number, number> {
    const counts: Record<number, number> = {};
    for (const scopeId of scopedTabIds(this.order, liveTabs)) {
      const count = scopeTabIds(scopeId, this.order, liveTabs).length;
      if (count > 0) counts[scopeId] = count;
    }
    return counts;
  }

  noteActivation(tabId: string, liveTabs: Map<string, ManagedTab>): boolean {
    const live = liveTabs.get(tabId);
    const metadata = live?.metadata ?? this.dormant.get(tabId)?.metadata;
    if (
      metadata &&
      metadata.scopeId !== null &&
      (live ? isPersistableLiveTab(live) : isPersistentMetadata(metadata))
    ) {
      this.lastPersistentActive.set(metadata.scopeId, tabId);
      return true;
    }
    return false;
  }

  remove(
    tabId: string,
    liveTabs: Map<string, ManagedTab>,
    addToClosedStack: boolean,
  ): { scopeId: BrowserTabScopeId; nextId: string | null } | null {
    const metadata = liveTabs.get(tabId)?.metadata ?? this.dormant.get(tabId)?.metadata;
    if (!metadata) return null;
    const scopeId = metadata.scopeId;
    const ids = this.order.get(scopeId) ?? [];
    const index = ids.indexOf(tabId);
    const live = liveTabs.get(tabId);
    const isPersistent = live ? isPersistableLiveTab(live) : isPersistentMetadata(metadata);
    if (addToClosedStack && scopeId !== null && isPersistent) {
      this.pushClosed(scopeId, restorableFromMetadata(metadata, live?.profile.id));
    }
    this.dormant.delete(tabId);
    this.pinnedIds.delete(tabId);
    if (index >= 0) ids.splice(index, 1);
    if (ids.length === 0) this.order.delete(scopeId);
    if (scopeId !== null && this.lastPersistentActive.get(scopeId) === tabId) {
      this.lastPersistentActive.delete(scopeId);
    }
    return { scopeId, nextId: ids[index] ?? ids[index - 1] ?? null };
  }

  clearScope(scopeId: number, liveTabs: Map<string, ManagedTab>): ManagedTab[] {
    const ids = scopeTabIds(scopeId, this.order, liveTabs);
    const live = ids.flatMap((id) => {
      const tab = liveTabs.get(id);
      return tab ? [tab] : [];
    });
    for (const id of ids) {
      this.dormant.delete(id);
      this.pinnedIds.delete(id);
    }
    this.order.delete(scopeId);
    this.closed.delete(scopeId);
    this.lastPersistentActive.delete(scopeId);
    return live;
  }

  setPinned(tabId: string, pinned: boolean, liveTabs: Map<string, ManagedTab>): boolean {
    const live = liveTabs.get(tabId);
    const dormant = this.dormant.get(tabId);
    const metadata = live?.metadata ?? dormant?.metadata;
    if (!metadata || metadata.pinned === pinned) return false;
    const next = { ...metadata, pinned };
    if (live) live.metadata = next;
    if (dormant) dormant.metadata = next;
    if (pinned) this.pinnedIds.add(tabId);
    else this.pinnedIds.delete(tabId);
    const ids = this.order.get(metadata.scopeId) ?? [];
    const index = ids.indexOf(tabId);
    if (index >= 0) ids.splice(index, 1);
    const pinnedCount = ids.filter((id) => {
      const item = liveTabs.get(id)?.metadata ?? this.dormant.get(id)?.metadata;
      return item?.pinned === true;
    }).length;
    ids.splice(pinnedCount, 0, tabId);
    return true;
  }

  reorder(tabId: string, targetIndex: number, liveTabs: Map<string, ManagedTab>): boolean {
    const metadata = liveTabs.get(tabId)?.metadata ?? this.dormant.get(tabId)?.metadata;
    if (!metadata) return false;
    const ids = this.order.get(metadata.scopeId);
    if (!ids) return false;
    const oldIndex = ids.indexOf(tabId);
    if (oldIndex < 0) return false;
    const pinnedCount = pinnedTabCount(metadata.scopeId, this.order, liveTabs, this.dormant);
    const min = metadata.pinned ? 0 : pinnedCount;
    const max = metadata.pinned ? Math.max(0, pinnedCount - 1) : ids.length - 1;
    const clamped = Math.max(min, Math.min(max, Math.trunc(targetIndex)));
    if (oldIndex === clamped) return false;
    ids.splice(oldIndex, 1);
    ids.splice(clamped, 0, tabId);
    return true;
  }

  closeOtherIds(tabId: string, liveTabs: Map<string, ManagedTab>): string[] {
    const target = liveTabs.get(tabId)?.metadata ?? this.dormant.get(tabId)?.metadata;
    if (!target) return [];
    return scopeTabIds(target.scopeId, this.order, liveTabs).filter((id) => {
      if (id === tabId) return false;
      const metadata = liveTabs.get(id)?.metadata ?? this.dormant.get(id)?.metadata;
      return metadata?.pinned !== true;
    });
  }

  lastClosed(scopeId: number): RestorableBrowserTab | null {
    return this.closed.get(scopeId)?.at(-1) ?? null;
  }

  consumeClosed(scopeId: number, expected: RestorableBrowserTab): void {
    const stack = this.closed.get(scopeId);
    if (stack?.at(-1) !== expected) return;
    stack.pop();
    if (stack.length === 0) this.closed.delete(scopeId);
  }

  schedulePersistence(
    scopeId: number,
    liveTabs: Map<string, ManagedTab>,
    activeId: string | null,
  ): void {
    if (!this.persistence.isEnabled(scopeId)) return;
    try {
      this.persistence.schedule(scopeId, this.persistableScope(scopeId, liveTabs, activeId));
    } catch (error) {
      this.reportError(
        translateUi("workspace.browser.tab.saveFailed", "Could not save Browser tabs: {{detail}}", {
          detail: browserTabErrorMessage(error),
        }),
        scopeId,
      );
    }
  }

  flush(): Promise<void> {
    return this.persistence.flush();
  }

  async prepareForWindowClose(
    liveTabs: Map<string, ManagedTab>,
    activeByScope: Map<number | null, string>,
  ): Promise<void> {
    this.scheduleCurrentScopes(liveTabs, activeByScope);
    this.persistence.freeze();
    try {
      await this.persistence.flush();
    } finally {
      this.persistence.unfreeze();
    }
  }

  async prepareForShutdown(
    liveTabs: Map<string, ManagedTab>,
    activeByScope: Map<number | null, string>,
  ): Promise<void> {
    this.scheduleCurrentScopes(liveTabs, activeByScope);
    this.persistence.freeze();
    try {
      await this.persistence.flush();
    } catch (error) {
      this.persistence.unfreeze();
      throw error;
    }
  }

  resumeAfterShutdownAbort(): void {
    this.persistence.unfreeze();
  }

  private scheduleCurrentScopes(
    liveTabs: Map<string, ManagedTab>,
    activeByScope: Map<number | null, string>,
  ): void {
    for (const scopeId of scopedTabIds(this.order, liveTabs)) {
      this.schedulePersistence(scopeId, liveTabs, activeByScope.get(scopeId) ?? null);
    }
  }

  private async restore(scopeId: number, currentActiveId: string | null): Promise<string | null> {
    const saved = await this.persistence.restoreScope(scopeId);
    if (!saved) return currentActiveId;
    const activeTab = saved.tabs[saved.activeIndex];
    const sortedTabs = saved.tabs
      .map((tab) => ({ tab }))
      .sort((left, right) => Number(right.tab.pinned) - Number(left.tab.pinned));
    const restoredIds = sortedTabs.map(({ tab }) => this.addDormant(scopeId, tab));
    const currentIds = this.order.get(scopeId) ?? [];
    this.order.set(
      scopeId,
      [...restoredIds, ...currentIds].sort(
        (left, right) => Number(this.pinnedIds.has(right)) - Number(this.pinnedIds.has(left)),
      ),
    );
    const restoredActiveIndex = sortedTabs.findIndex(({ tab }) => tab === activeTab);
    const restoredActive = restoredIds[restoredActiveIndex] ?? null;
    if (restoredActive) this.lastPersistentActive.set(scopeId, restoredActive);
    return currentActiveId ?? restoredActive;
  }

  private addDormant(scopeId: number, saved: RestorableBrowserTab): string {
    const id = randomUUID();
    this.dormant.set(id, {
      metadata: {
        id,
        title: saved.title,
        defaultTitle: saved.defaultTitle,
        url: saved.url,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        sessionProfileId: saved.sessionProfileId,
        isActive: false,
        devToolsOpen: false,
        pinned: saved.pinned,
        suspended: true,
        zoomPercent: 100,
        responsive: { ...DEFAULT_BROWSER_RESPONSIVE_STATE },
        scopeId,
      },
    });
    if (saved.pinned) this.pinnedIds.add(id);
    return id;
  }

  private persistableScope(
    scopeId: number,
    liveTabs: Map<string, ManagedTab>,
    activeId: string | null,
  ): RestorableBrowserScope | null {
    const tabsWithIds = this.persistableItems(scopeId, liveTabs);
    if (tabsWithIds.length === 0) return null;
    if (tabsWithIds.length > MAX_RESTORABLE_TABS_PER_SCOPE) {
      throw new Error(
        translateUi(
          "workspace.browser.tab.limit",
          "Normal Browser tabs are limited to {{count}} per feature.",
          { count: MAX_RESTORABLE_TABS_PER_SCOPE },
        ),
      );
    }
    const selectedId = tabsWithIds.some(({ id }) => id === activeId)
      ? activeId
      : this.lastPersistentActive.get(scopeId);
    const activeIndex = Math.max(
      0,
      tabsWithIds.findIndex(({ id }) => id === selectedId),
    );
    return {
      tabs: tabsWithIds.map(({ tab }) => tab),
      activeIndex,
    };
  }

  private persistableItems(
    scopeId: number,
    liveTabs: Map<string, ManagedTab>,
  ): Array<{ id: string; tab: RestorableBrowserTab }> {
    return scopeTabIds(scopeId, this.order, liveTabs).flatMap((id) => {
      const live = liveTabs.get(id);
      const metadata = live?.metadata ?? this.dormant.get(id)?.metadata;
      const persistent = live
        ? isPersistableLiveTab(live)
        : metadata && isPersistentMetadata(metadata);
      return metadata && persistent
        ? [{ id, tab: restorableFromMetadata(metadata, live?.profile.id) }]
        : [];
    });
  }

  private pushClosed(scopeId: number, tab: RestorableBrowserTab): void {
    const stack = this.closed.get(scopeId) ?? [];
    stack.push(tab);
    if (stack.length > MAX_CLOSED_TABS_PER_SCOPE) stack.shift();
    this.closed.set(scopeId, stack);
  }
}
