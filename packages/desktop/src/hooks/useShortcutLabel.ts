import { useMemo } from "react";
import { formatCombo, formatCompactCombo } from "@/lib/shortcuts/format";
import { useResolvedShortcut } from "@/lib/shortcuts/overrides";
import type { ShortcutId } from "@/lib/shortcuts/registry";

/** A registry shortcut's current binding as one label ("⌘↵", "Ctrl+R"), rebinds included. */
export function useShortcutLabel(id: ShortcutId): string {
  const { keys } = useResolvedShortcut(id);
  return useMemo(() => formatCompactCombo(keys), [keys]);
}

/** The same binding as separate key glyphs, for `KbdShortcut` / `ShortcutTooltip`. */
export function useShortcutKeys(id: ShortcutId): string[] {
  // Memoized so memo'd consumers (e.g. ResizableSidebarLayout) keep a stable prop.
  const { keys } = useResolvedShortcut(id);
  return useMemo(() => formatCombo(keys), [keys]);
}
