import { useEffect, useRef } from "react";
import { isPaletteShortcut } from "@/lib/command-palette/palette-shortcut-commands";
import {
  paletteKeyboardEvent,
  registerShortcutAction,
} from "@/lib/command-palette/shortcut-actions";
import type { ShortcutId } from "@/lib/shortcuts/registry";

/**
 * Offers a shortcut's handler to the command palette while it is mounted and
 * enabled. Ids the palette doesn't list cost nothing. The latest `callback`
 * runs, like the key binding itself.
 */
export function useShortcutPaletteAction(
  id: ShortcutId,
  callback: (event: KeyboardEvent) => unknown,
  enabled: boolean,
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const listed = isPaletteShortcut(id);
  useEffect(() => {
    if (!listed || !enabled) return undefined;
    return registerShortcutAction(id, () => {
      void callbackRef.current(paletteKeyboardEvent());
    });
  }, [enabled, id, listed]);
}
