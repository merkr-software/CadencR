import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import {
  isBuiltinTabKind,
  type FeatureLayoutState,
  type TabKind,
} from "@/stores/feature-layout-schema";
import {
  findPaneContaining,
  selectFeatureLayout,
  useFeatureLayoutStore,
} from "@/stores/feature-layout-store";
import { makeTabHostKey, useTabHostRegistry } from "@/stores/tab-host-registry";

import { tabIdsKey, useStableTabIds } from "./feature-tabs";
import { restoreTabFocus, useTabFocusMemory } from "./tab-focus-preservation";
import type { FeatureTabs } from "./types";

interface TabContentRegistryProps {
  featureId: number;
  tabs: FeatureTabs;
  layoutState?: FeatureLayoutState;
  mountVisibleOnly?: boolean;
}

/**
 * Mounts every tab's content **once** and projects it into whichever pane
 * currently hosts it.
 *
 * # Why imperative DOM moves and not portal-target swaps?
 *
 * `createPortal(children, target)` treats `target` as part of the portal's
 * identity — when `target` changes between renders, React unmounts the
 * children from the old container and mounts a fresh tree in the new one.
 * That destroys xterm, detaches the live PTY `<textarea>` (so keystrokes go
 * nowhere), and resets the agent WebSocket session.
 *
 * Instead we keep each tab's portal target **constant** for as long as the
 * tab exists: one stable `<div>` per tab id in `tabs`, created the first
 * render that id shows up (built-ins: the first render) and dropped from the
 * DOM when the id leaves `tabs` (a plugin got disabled). Tabs always portal
 * into the same `<div>`. To move a tab between panes we
 * `appendChild` the **target itself** into the new pane's host — React
 * never sees this; only the DOM tree's parent chain changes. xterm,
 * CodeMirror, and the WS session all survive every drag intact.
 */
export function TabContentRegistry({
  featureId,
  tabs,
  layoutState: layoutStateOverride,
  mountVisibleOnly = false,
}: TabContentRegistryProps): ReactNode {
  // Every mount `<div>` ever created, by tab id. Lives as long as the
  // registry; entries leave only when their tab leaves `tabs`.
  const [mountCache] = useState(() => new Map<TabKind, HTMLDivElement>());
  const tabIds = useStableTabIds(tabs);
  // Keyed on the identity-stable ids, not `tabs` (a fresh object every caller
  // render): a stable record is what keeps the move effect and focus memory
  // inert. Synchronous so portals always have a target, even before any effect runs.
  const tabMounts = useMemo(() => resolveTabMounts(mountCache, tabIds), [mountCache, tabIds]);

  // A tab that left `tabs` already had its portal unmounted by this commit;
  // drop its mount `<div>` too.
  useLayoutEffect(() => {
    for (const [tab, mount] of mountCache) {
      if (tabMounts[tab] === mount) continue;
      mount.remove();
      mountCache.delete(tab);
    }
  }, [mountCache, tabMounts]);

  // Detach the mount divs from the DOM when the registry unmounts so we don't
  // leak orphan nodes if the consumer page navigates away.
  useEffect(() => {
    return () => {
      for (const mount of mountCache.values()) mount.remove();
    };
  }, [mountCache]);

  const focusMemory = useTabFocusMemory(tabMounts);
  const storeLayoutState = useFeatureLayoutStore(selectFeatureLayout(featureId));
  const layoutState = layoutStateOverride ?? storeLayoutState;
  const hosts = useTabHostRegistry((s) => s.hosts);
  const [visitedTabs, setVisitedTabs] = useState<Partial<Record<TabKind, true>>>({});
  const placements = useMemo(() => placeTabs(layoutState, tabIds), [layoutState, tabIds]);
  const visibleTabs = tabIds.filter((tab) => placements.get(tab)?.isVisible);
  const visibleTabsKey = tabIdsKey(visibleTabs);

  // Keyed on `visibleTabsKey`, deliberately not on `visibleTabs`/`layoutState`:
  // the string is identity-stable, while both of those get a fresh identity on
  // every render wherever splits are off (`FeatureLayoutShell` substitutes a
  // flat layout there). With an object in the deps this effect re-ran every
  // render and re-scheduled `setVisitedTabs`. An updater returning `prev` does
  // not save you: it only skips scheduling through React's eager-bailout fast
  // path, which is disabled whenever the fiber already has queued work — so
  // under an agent stream it left a Default-lane update pending at the tail of
  // nearly every commit, and that is precisely what React counts toward
  // "Maximum update depth exceeded" (#185). The closure reads `visibleTabs`,
  // which the key fully determines, so it can never go stale.
  useEffect(() => {
    if (!mountVisibleOnly) return;
    setVisitedTabs((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const tab of visibleTabs) {
        if (next[tab]) continue;
        next[tab] = true;
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [mountVisibleOnly, visibleTabsKey]);

  // Move each tab-mount into the host pane currently owning that tab. Runs
  // *synchronously* before paint so the user never sees a flash of misplaced
  // content. When no host is registered yet (e.g. the new pane just got
  // inserted into the tree but its content `<div>` hasn't committed) we park
  // the mount on `document.body` with `display:none`. The React subtree
  // stays alive throughout — content reappears as soon as the host shows up.
  // xterm wakes itself up via its own IntersectionObserver once the mount is
  // back on screen, so we don't need to force RO to fire here.
  useLayoutEffect(() => {
    if (typeof document === "undefined") return;
    let moved = false;
    for (const [tab, mount] of Object.entries(tabMounts) as Array<[TabKind, HTMLDivElement]>) {
      const placement = placements.get(tab) ?? UNPLACED;
      const host = placement.paneId
        ? hosts[makeTabHostKey(featureId, placement.paneId)]
        : undefined;
      const willBeVisible = !!(host && placement.isVisible);
      if (!shouldMountTab(tab, placement, mountVisibleOnly, visitedTabs)) {
        mount.remove();
        mount.style.display = "none";
        continue;
      }
      const desiredParent = host ?? document.body;
      if (mount.parentNode !== desiredParent) {
        desiredParent.appendChild(mount);
        moved = true;
      }
      mount.style.display = willBeVisible ? "" : "none";
    }
    // A split re-parents the pane the user was typing in; keep their focus.
    if (moved) restoreTabFocus(focusMemory.current);
  }, [featureId, focusMemory, hosts, mountVisibleOnly, placements, tabMounts, visitedTabs]);

  return (
    <div style={{ display: "contents" }}>
      {tabIds.map((tab) => {
        const def = tabs[tab];
        const mount = tabMounts[tab];
        if (!def || !mount) return null;
        const placement = placements.get(tab) ?? UNPLACED;
        if (!shouldMountTab(tab, placement, mountVisibleOnly, visitedTabs)) return null;
        return createPortal(def.content, mount, tab);
      })}
    </div>
  );
}

/** Current mounts for `tabIds`, creating (into `cache`) the ones that are new. */
function resolveTabMounts(
  cache: Map<TabKind, HTMLDivElement>,
  tabIds: readonly TabKind[],
): Partial<Record<TabKind, HTMLDivElement>> {
  const mounts: Partial<Record<TabKind, HTMLDivElement>> = {};
  if (typeof document === "undefined") return mounts;
  for (const tab of tabIds) {
    let el = cache.get(tab);
    if (!el) {
      el = document.createElement("div");
      el.className = "h-full w-full";
      el.setAttribute("data-tab-mount", tab);
      // Hidden until the move-effect parents us under a real host.
      el.style.display = "none";
      cache.set(tab, el);
    }
    mounts[tab] = el;
  }
  return mounts;
}

interface TabPlacement {
  /** Pane hosting the tab, `null` when it is not placed in the layout. */
  paneId: string | null;
  /** Placed and the active tab of its pane. */
  isVisible: boolean;
}

const UNPLACED: TabPlacement = { paneId: null, isVisible: false };

/** One tree walk per tab per layout, shared by the render pass and the move effect. */
function placeTabs(
  layout: FeatureLayoutState,
  tabIds: readonly TabKind[],
): Map<TabKind, TabPlacement> {
  const placements = new Map<TabKind, TabPlacement>();
  for (const tab of tabIds) {
    const leaf = findPaneContaining(layout.splitRoot, tab);
    placements.set(tab, { paneId: leaf?.id ?? null, isVisible: leaf?.activeTabId === tab });
  }
  return placements;
}

/**
 * Whether a tab's content should be alive. Built-ins always are (subject to
 * `mountVisibleOnly`), even unplaced — they're parked hidden. A plugin tab
 * mounts only while placed in the layout: one that's merely available (listed
 * in the "+" menu) must not spin up its guest.
 */
function shouldMountTab(
  tab: TabKind,
  placement: TabPlacement,
  mountVisibleOnly: boolean,
  visitedTabs: Partial<Record<TabKind, true>>,
): boolean {
  if (!isBuiltinTabKind(tab) && placement.paneId === null) return false;
  return !mountVisibleOnly || placement.isVisible || !!visitedTabs[tab];
}
