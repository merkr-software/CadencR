import { useMemo } from "react";

import type { TabShortcut } from "@/api/generated";
import {
  activeShortcuts,
  appShortcutBindings,
  resolveTabShortcuts,
  type ResolvedTabShortcut,
} from "@/lib/plugin-tabs/tab-shortcuts";
import { PLATFORM_IS_MAC } from "@/lib/shortcuts/format";
import { useShortcutOverridesStore } from "@/lib/shortcuts/overrides";
import type { PluginTabOwnShortcut } from "@/shared/plugin-tab-host";

/** A tab's declared shortcuts, each with the Cadencr shortcut that takes its keys, if any. */
export function useResolvedTabShortcuts(
  shortcuts: readonly TabShortcut[],
  surface: "tab" | "editor" = "tab",
): readonly ResolvedTabShortcut[] {
  const overrides = useShortcutOverridesStore((state) => state.overrides);
  return useMemo(
    () => resolveTabShortcuts(shortcuts, appShortcutBindings(overrides, surface), PLATFORM_IS_MAC),
    [shortcuts, overrides, surface],
  );
}

/** The declared shortcuts that can fire; identity-stable while they are unchanged. */
export function useActiveTabShortcuts(
  shortcuts: readonly TabShortcut[],
  surface: "tab" | "editor" = "tab",
): readonly PluginTabOwnShortcut[] {
  const resolved = useResolvedTabShortcuts(shortcuts, surface);
  // A list refetch hands over equal manifests under new identities: key on content.
  const key = useMemo(
    () => JSON.stringify(activeShortcuts(resolved).map(({ id, keys }) => ({ id, keys }))),
    [resolved],
  );
  return useMemo(() => JSON.parse(key) as PluginTabOwnShortcut[], [key]);
}
