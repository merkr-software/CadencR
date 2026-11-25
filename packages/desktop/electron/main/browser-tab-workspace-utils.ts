import { isPersistentProfileId } from "./browser-profiles";
import type { ManagedTab } from "./browser-tab-events";
import type { RestorableBrowserTab } from "./browser-tab-session-store";
import type { BrowserTabMetadata } from "./browser-types";

export type BrowserTabScopeId = number | null;
export type DormantBrowserTab = { metadata: BrowserTabMetadata };

export function restorableFromMetadata(
  metadata: BrowserTabMetadata,
  resolvedProfileId = metadata.sessionProfileId.replace(/^persistent:/, ""),
): RestorableBrowserTab {
  return {
    title: metadata.title,
    ...(metadata.defaultTitle ? { defaultTitle: true as const } : {}),
    url: metadata.url,
    sessionProfileId: resolvedProfileId,
    pinned: metadata.pinned,
  };
}

export function isPersistentMetadata(metadata: BrowserTabMetadata): boolean {
  return (
    metadata.sessionProfileId !== "fresh" &&
    metadata.sessionProfileId !== "feature" &&
    isPersistentProfileId(metadata.sessionProfileId)
  );
}

export function isPersistableLiveTab(tab: ManagedTab): boolean {
  return tab.profile.mode === "persistent" && tab.automationAccess !== "agent" && !tab.temporary;
}

export function browserTabErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function workspaceMetadata(
  scopeId: BrowserTabScopeId | undefined,
  liveTabs: Map<string, ManagedTab>,
  dormant: Map<string, DormantBrowserTab>,
  order: Map<BrowserTabScopeId, string[]>,
  activeId: string | null,
): BrowserTabMetadata[] {
  const ids =
    scopeId === undefined
      ? allOrderedTabIds(order, liveTabs)
      : scopeTabIds(scopeId, order, liveTabs);
  return ids.flatMap((id) => {
    const metadata = liveTabs.get(id)?.metadata ?? dormant.get(id)?.metadata;
    if (!metadata) return [];
    if (scopeId === undefined) return [metadata];
    const isActive = id === activeId;
    if (metadata.isActive === isActive) return [metadata];
    const next = { ...metadata, isActive };
    const live = liveTabs.get(id);
    const sleeping = dormant.get(id);
    if (live) live.metadata = next;
    if (sleeping) sleeping.metadata = next;
    return [next];
  });
}

export function insertOrderedTab(
  order: Map<BrowserTabScopeId, string[]>,
  pinnedIds: Set<string>,
  scopeId: BrowserTabScopeId,
  tabId: string,
  pinned: boolean,
): void {
  const ids = order.get(scopeId) ?? [];
  if (ids.includes(tabId)) return;
  if (pinned) ids.splice(ids.filter((id) => pinnedIds.has(id)).length, 0, tabId);
  else ids.push(tabId);
  order.set(scopeId, ids);
}

export function pinnedTabCount(
  scopeId: BrowserTabScopeId,
  order: Map<BrowserTabScopeId, string[]>,
  liveTabs: Map<string, ManagedTab>,
  dormant: Map<string, DormantBrowserTab>,
): number {
  return scopeTabIds(scopeId, order, liveTabs).filter((id) => {
    const metadata = liveTabs.get(id)?.metadata ?? dormant.get(id)?.metadata;
    return metadata?.pinned === true;
  }).length;
}

export function scopeTabIds(
  scopeId: BrowserTabScopeId,
  order: Map<BrowserTabScopeId, string[]>,
  liveTabs: Map<string, ManagedTab>,
): string[] {
  const ordered = order.get(scopeId) ?? [];
  const orderedIds = new Set(ordered);
  const extras = [...liveTabs.values()]
    .filter((tab) => tab.metadata.scopeId === scopeId && !orderedIds.has(tab.metadata.id))
    .map((tab) => tab.metadata.id);
  return [...ordered, ...extras];
}

export function scopedTabIds(
  order: Map<BrowserTabScopeId, string[]>,
  liveTabs: Map<string, ManagedTab>,
): number[] {
  const scopes = new Set<number>();
  for (const scope of order.keys()) if (scope !== null) scopes.add(scope);
  for (const tab of liveTabs.values()) {
    if (tab.metadata.scopeId !== null) scopes.add(tab.metadata.scopeId);
  }
  return [...scopes];
}

function allOrderedTabIds(
  order: Map<BrowserTabScopeId, string[]>,
  liveTabs: Map<string, ManagedTab>,
): string[] {
  const ordered = [...order.values()].flat();
  const orderedIds = new Set(ordered);
  const extras = [...liveTabs.keys()].filter((id) => !orderedIds.has(id));
  return [...ordered, ...extras];
}
