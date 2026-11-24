import type { BuiltinTabKind, TabKind } from "@/stores/feature-layout-schema";

import type { FeatureTabDef, FeatureTabs } from "./types";

/** The tabs the phone tab bar always shows, in order; every other tab goes under More. */
const PHONE_BAR_TABS: readonly BuiltinTabKind[] = ["agent", "terminal", "git", "editor"];

/** Shorter names where the bar's label has a few characters of room. */
const PHONE_TAB_LABELS: Partial<Record<TabKind, string>> = { editor: "Files" };

export function phoneTabLabel(tab: TabKind, def: FeatureTabDef): string {
  return PHONE_TAB_LABELS[tab] ?? def.label;
}

export interface PhoneTabGroups {
  /** Tabs with a slot of their own in the bar. */
  bar: TabKind[];
  /** Tabs listed in the More sheet, in the layout's order. */
  more: TabKind[];
}

/**
 * Splits the pane's tabs between the bar and the More sheet. Only tabs the
 * layout holds and that have a definition count (an unavailable plugin's tab
 * stays hidden, as in the strip).
 */
export function splitPhoneTabs(tabIds: readonly TabKind[], tabs: FeatureTabs): PhoneTabGroups {
  const present = tabIds.filter((tab) => tabs[tab] != null);
  const inBar = new Set<TabKind>(PHONE_BAR_TABS);
  return {
    bar: PHONE_BAR_TABS.filter((tab) => present.includes(tab)),
    more: present.filter((tab) => !inBar.has(tab)),
  };
}

/**
 * Next tab to focus for an arrow key in the tablist (wraps), or null: the
 * orientation's arrows, Left/Right for the bar, Up/Down for a rail in a side
 * strip.
 */
export function rovingTabIndex(
  key: string,
  index: number,
  count: number,
  orientation: "horizontal" | "vertical" = "horizontal",
): number | null {
  if (count === 0) return null;
  const [previous, next] =
    orientation === "vertical" ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
  if (key === next) return (index + 1) % count;
  if (key === previous) return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}
