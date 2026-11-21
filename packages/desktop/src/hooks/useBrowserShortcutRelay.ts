import { useEffect, useRef } from "react";

import { useWorkspaceActivity } from "@/components/workspace-pool/workspace-activity";
import { desktopBridge, type BrowserShortcut } from "@/lib/desktop-bridge";

/**
 * Subscribe to main-process browser shortcut relays — the chords fired when the
 * native guest page (a WebContentsView) holds keyboard focus and the renderer's
 * own listeners never see the keydown (see `browser-tab-events.ts`).
 *
 * The handler is read from a ref so the IPC listener is bound exactly once and
 * never re-bound, while still calling the latest closure over fresh render state.
 *
 * The main process sends each relay to every listener: one in a conversation
 * workspace kept mounted but hidden (`WorkspacePool`) ignores it, read when the
 * relay arrives so a switch re-renders nothing.
 */
export function useBrowserShortcutRelay(handler: (shortcut: BrowserShortcut) => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const activity = useWorkspaceActivity();
  useEffect(
    () =>
      desktopBridge.onBrowserShortcut((shortcut) => {
        if (activity.isActive()) handlerRef.current(shortcut);
      }),
    [activity],
  );
}
