import { useMemo } from "react";

import type { PluginTabSummary } from "@/api/generated";
import { pluginTabsAvailable } from "@/lib/plugin-tabs/availability";
import {
  activeShortcuts,
  appShortcutBindings,
  resolveTabShortcuts,
} from "@/lib/plugin-tabs/tab-shortcuts";
import { PLATFORM_IS_MAC } from "@/lib/shortcuts/format";
import { useShortcutOverridesStore } from "@/lib/shortcuts/overrides";

import { staticOverlayState } from "./PluginTabView";
import { useProjectPluginTabs } from "./usePluginTabDefs";

/** A cheatsheet group of one custom tab's own shortcuts. */
export interface CustomTabShortcutGroup {
  /** `plugin:<tab id>`, apart from Cadencr's scope ids. */
  id: string;
  label: string;
  hint: string;
  items: { id: string; description: string; keys: string[] }[];
}

/**
 * The shortcuts of the custom tabs the project can open here, leaving out
 * those whose keys Cadencr takes — they never fire.
 */
export function customTabShortcutGroups(
  tabs: readonly PluginTabSummary[],
  overrides: Parameters<typeof appShortcutBindings>[0],
  isMac: boolean,
): CustomTabShortcutGroup[] {
  const app = appShortcutBindings(overrides);
  return tabs.flatMap((tab) => {
    if (tab.shortcuts.length === 0 || staticOverlayState(tab, true) !== null) return [];
    const items = activeShortcuts(resolveTabShortcuts(tab.shortcuts, app, isMac)).map(
      (shortcut) => ({
        id: `plugin:${tab.id}:${shortcut.id}`,
        description: shortcut.description,
        keys: shortcut.keys,
      }),
    );
    if (items.length === 0) return [];
    return [
      {
        id: `plugin:${tab.id}`,
        label: tab.name,
        hint: `When the ${tab.label} tab has focus.`,
        items,
      },
    ];
  });
}

const NO_GROUPS: CustomTabShortcutGroup[] = [];

/** `customTabShortcutGroups` for the project on screen; built only while `enabled`. */
export function useCustomTabShortcutGroups(
  projectId: number | null,
  enabled: boolean,
): CustomTabShortcutGroup[] {
  const active = enabled && pluginTabsAvailable() && projectId !== null;
  const overrides = useShortcutOverridesStore((state) => state.overrides);
  const { data: tabs } = useProjectPluginTabs(projectId ?? 0, active);
  return useMemo(
    () => (active && tabs ? customTabShortcutGroups(tabs, overrides, PLATFORM_IS_MAC) : NO_GROUPS),
    [active, tabs, overrides],
  );
}
