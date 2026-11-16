import { useMemo } from "react";

import { isTabKind, type TabKind } from "@/stores/feature-layout-schema";

import type { FeatureTabs } from "./types";

/** Ids of the tabs that have a definition right now, in `tabs` order. */
function featureTabIds(tabs: FeatureTabs): TabKind[] {
  return Object.entries(tabs).flatMap(([tab, def]) => (def && isTabKind(tab) ? [tab] : []));
}

/**
 * Identity-stable key for a tab id list: memoize on this rather than on an
 * array or the `tabs` object, which callers rebuild every render. Tab ids
 * never contain "|" (see `isPluginTabKind`).
 */
export function tabIdsKey(tabIds: readonly TabKind[]): string {
  return tabIds.join("|");
}

/**
 * Ids of the defined tabs as an array whose identity only changes when the ids
 * do. Callers rebuild `tabs` every render; memoizing on it directly would
 * re-run layout effects every render — the mobile #185 crash (see
 * `TabContentRegistry`).
 */
export function useStableTabIds(tabs: FeatureTabs): readonly TabKind[] {
  const key = tabIdsKey(featureTabIds(tabs));
  return useMemo(() => (key === "" ? [] : (key.split("|") as TabKind[])), [key]);
}
