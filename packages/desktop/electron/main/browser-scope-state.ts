import type { ManagedTab } from "./browser-tab-events";
import type { BrowserBounds, BrowserStateSnapshot } from "./browser-types";

/**
 * Per-feature-scope bookkeeping for the browser: which tab is active in each
 * scope and the viewport bounds each scope's workspace currently occupies.
 *
 * Tabs are isolated by scope (see `BrowserTabMetadata.scopeId`) so a tab opened
 * in one feature's Browser never leaks into another's. A scope enters these
 * maps once its workspace opens a tab or reports non-empty viewport bounds.
 * Agent/MCP tabs carry their feature's scope; scopeless (`null`) tabs only come
 * from automation calls without a feature and have no UI workspace.
 */
export class BrowserScopeState {
  readonly active = new Map<number | null, string>();
  readonly bounds = new Map<number | null, BrowserBounds>();
  readonly rendererZoom = new Map<number | null, number>();
  // Most-recently activated tab across every scope — drives the unscoped
  // snapshot consumed by agent/MCP automation.
  globalActiveTabId: string | null = null;

  activate(scope: number | null, tabId: string): void {
    this.active.set(scope, tabId);
    this.globalActiveTabId = tabId;
  }

  activeTabId(scopeId: number | null | undefined): string | null {
    return scopeId === undefined ? this.globalActiveTabId : (this.active.get(scopeId) ?? null);
  }

  /**
   * A zero-size viewport means the workspace is hidden/unmounted: drop the scope
   * so its tabs detach and it stops receiving state broadcasts.
   */
  setBounds(scope: number | null, bounds: BrowserBounds, zoomFactor = 1): void {
    if (bounds.width > 0 && bounds.height > 0) {
      this.bounds.set(scope, bounds);
      this.rendererZoom.set(scope, zoomFactor > 0 ? zoomFactor : 1);
    } else {
      this.bounds.delete(scope);
      this.rendererZoom.delete(scope);
    }
  }

  clearBounds(): void {
    this.bounds.clear();
    this.rendererZoom.clear();
  }

  /**
   * Forget a closed tab. Returns the next tab in the same scope to promote when
   * the closed tab was that scope's active one (so closing a tab never reveals
   * another feature's tab), or `null` when nothing needs re-activating.
   */
  forget(scope: number | null, tabId: string, tabs: Map<string, ManagedTab>): string | null {
    // Keep the unscoped (agent/MCP) view coherent: fall back to any surviving
    // tab rather than stranding it at null when this scope had nothing to
    // promote. `tabs` already excludes the closed tab.
    if (this.globalActiveTabId === tabId) {
      this.globalActiveTabId = tabs.keys().next().value ?? null;
    }
    if (this.active.get(scope) !== tabId) return null;
    this.active.delete(scope);
    for (const [id, tab] of tabs) {
      if (tab.metadata.scopeId === scope) return id;
    }
    return null;
  }

  /** Recompute the `isActive` flag for every tab from its scope's active tab. */
  refreshActiveFlags(tabs: Map<string, ManagedTab>): void {
    for (const [id, item] of tabs) {
      const isActive = this.active.get(item.metadata.scopeId) === id;
      if (item.metadata.isActive !== isActive) {
        item.metadata = { ...item.metadata, isActive };
      }
    }
  }

  /**
   * Build a snapshot for one feature scope, or — when `scopeId` is omitted — the
   * unscoped all-tabs view used by agent/MCP automation. Scoped snapshots only
   * carry that scope's own tabs so a feature never sees another's.
   */
  snapshot(
    scopeId: number | null | undefined,
    tabs: Map<string, ManagedTab>,
    knownOrigins: string[],
    error: string | null,
    orderedMetadata?: BrowserStateSnapshot["tabs"],
  ): BrowserStateSnapshot {
    const scoped = scopeId !== undefined;
    const visible = scoped
      ? [...tabs.values()].filter((tab) => tab.metadata.scopeId === scopeId)
      : [...tabs.values()];
    const activeTabId = scoped ? (this.active.get(scopeId) ?? null) : this.globalActiveTabId;
    const activeTab = activeTabId ? tabs.get(activeTabId) : null;
    return {
      scopeId: scoped ? scopeId : null,
      tabs: orderedMetadata ?? visible.map((tab) => tab.metadata),
      activeTabId,
      consoleEntries: activeTab?.consoleEntries ?? [],
      networkEntries: activeTab?.networkEntries ?? [],
      knownOrigins,
      error,
    };
  }
}
