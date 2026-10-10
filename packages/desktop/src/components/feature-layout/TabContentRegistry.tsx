import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import {
  ALL_TAB_KINDS,
  type FeatureLayoutState,
  type TabKind,
} from "@/stores/feature-layout-schema";
import {
  findHostFor,
  isTabVisible,
  selectFeatureLayout,
  useFeatureLayoutStore,
} from "@/stores/feature-layout-store";
import { makeTabHostKey, useTabHostRegistry } from "@/stores/tab-host-registry";

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
 * Instead we keep each tab's portal target **constant** for the lifetime of
 * the registry: one stable `<div>` per `TabKind`, created up front. Tabs
 * always portal into the same `<div>`. To move a tab between panes we
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
  // One stable mount `<div>` per tab kind. Created synchronously on first
  // render via a lazy `useState` initializer so portals always have a target,
  // even before any effect runs.
  const [tabMounts] = useState<Record<TabKind, HTMLDivElement>>(() => {
    const mounts = {} as Record<TabKind, HTMLDivElement>;
    if (typeof document === "undefined") return mounts;
    for (const tab of ALL_TAB_KINDS) {
      const el = document.createElement("div");
      el.className = "h-full w-full";
      el.setAttribute("data-tab-mount", tab);
      // Hidden until the move-effect below parents us under a real host.
      el.style.display = "none";
      mounts[tab] = el;
    }
    return mounts;
  });

  // Detach the mount divs from the DOM when the registry unmounts so we don't
  // leak orphan nodes if the consumer page navigates away.
  useEffect(() => {
    return () => {
      for (const tab of ALL_TAB_KINDS) {
        tabMounts[tab]?.remove();
      }
    };
  }, [tabMounts]);

  const focusMemory = useTabFocusMemory(tabMounts);
  const storeLayoutState = useFeatureLayoutStore(selectFeatureLayout(featureId));
  const layoutState = layoutStateOverride ?? storeLayoutState;
  const hosts = useTabHostRegistry((s) => s.hosts);
  const [visitedTabs, setVisitedTabs] = useState<Partial<Record<TabKind, true>>>({});
  const visibleTabs = ALL_TAB_KINDS.filter((tab) => isTabVisible(layoutState, tab));
  const visibleTabsKey = visibleTabs.join("|");

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
    for (const tab of ALL_TAB_KINDS) {
      const mount = tabMounts[tab];
      if (!mount) continue;
      const paneId = findHostFor(layoutState, tab);
      const hostKey = paneId ? makeTabHostKey(featureId, paneId) : null;
      const host = hostKey ? hosts[hostKey] : undefined;
      const isVisible = isTabVisible(layoutState, tab);
      const shouldMount = !mountVisibleOnly || isVisible || !!visitedTabs[tab];
      const willBeVisible = !!(host && isVisible);
      if (!shouldMount) {
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
  }, [featureId, focusMemory, hosts, layoutState, mountVisibleOnly, tabMounts, visitedTabs]);

  return (
    <div style={{ display: "contents" }}>
      {(Object.entries(tabs) as Array<[TabKind, (typeof tabs)[TabKind]]>).map(([tab, def]) => {
        if (mountVisibleOnly && !isTabVisible(layoutState, tab) && !visitedTabs[tab]) return null;
        const mount = tabMounts[tab];
        if (!mount) return null;
        return createPortal(def.content, mount, tab);
      })}
    </div>
  );
}
