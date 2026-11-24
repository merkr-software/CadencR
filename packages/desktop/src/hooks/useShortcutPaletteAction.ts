import { useEffect, useRef } from "react";
import { useWorkspaceActivity, whileActive } from "@/components/workspace-pool/workspace-activity";
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
  const activity = useWorkspaceActivity();
  useEffect(() => {
    if (!listed || !enabled) return undefined;
    // A hidden workspace's actions must not shadow the visible one's in the
    // palette: registered only while its workspace is on screen, without a
    // render at each switch.
    return whileActive(activity, () =>
      registerShortcutAction(id, () => {
        const event = paletteKeyboardEvent();
        void callbackRef.current(event);
        // A handler that takes the chord prevents its default.
        return event.defaultPrevented;
      }),
    );
  }, [activity, enabled, id, listed]);
}
