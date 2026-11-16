import { isDesktopShell } from "@/lib/desktop-bridge";
import { PLATFORM_IS_MAC } from "@/lib/shortcuts/format";

/**
 * True when the window chrome includes the macOS traffic-light buttons.
 * The Electron shell uses `titleBarStyle: "hiddenInset"`, which places them
 * inside the web content area (14pt buttons from x≈12 to x≈71), so
 * layouts near the top-left corner must reserve space for them. Gate that
 * clearance on this — remote-browser sessions and other platforms have no
 * traffic lights and would only get dead space.
 *
 * Both inputs are fixed for the process lifetime (the preload bridge is
 * injected before renderer modules evaluate, and the platform never changes),
 * so this is computed once at module load like `PLATFORM_IS_MAC` itself.
 */
export const HAS_MAC_WINDOW_CONTROLS = isDesktopShell() && PLATFORM_IS_MAC;
