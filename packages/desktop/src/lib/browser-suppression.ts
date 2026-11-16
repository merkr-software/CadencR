import { useLayoutEffect } from "react";
import { desktopBridge, isDesktopShell } from "@/lib/desktop-bridge";

/**
 * The embedded browser is a native `WebContentsView` that always paints above
 * the React DOM, so any overlay rendered over the viewport region (modals,
 * the address-bar autocomplete) would otherwise be hidden behind the guest
 * page. Mounting `useSuppressBrowserView()` asks the main process to hide the
 * native views while the overlay is open.
 *
 * Ref-counted so concurrent overlays (e.g. a dialog opened from within
 * another) compose correctly — the browser only returns once the last one
 * unmounts.
 */
let openCount = 0;

function sync(): void {
  // Suppression is best-effort UI polish; a failure must not bubble into the
  // overlay that requested it. The bridge resolves to a no-op off the desktop,
  // and the optional call tolerates partially-mocked bridges in tests.
  void desktopBridge.setBrowserSuppressed?.(openCount > 0)?.catch(() => undefined);
}

/** Suppress the native browser view for as long as the caller is mounted. */
export function useSuppressBrowserView(active = true): void {
  useLayoutEffect(() => {
    if (!active || !isDesktopShell()) return;
    openCount += 1;
    sync();
    return () => {
      openCount -= 1;
      sync();
    };
  }, [active]);
}

/**
 * Render inside an overlay's Radix `Content` (a dropdown menu; not a Select,
 * which keeps its content mounted while closed): Radix mounts that subtree
 * only while open, so the native view is hidden for exactly that window. Putting the hook in the overlay's own wrapper instead
 * would suppress forever — a controlled `open={x}` root stays mounted.
 */
export function SuppressBrowserViewWhileOpen(): null {
  useSuppressBrowserView();
  return null;
}
