import { isDesktopShell } from "@/lib/desktop-bridge";
import { isBrowserRemote } from "@/lib/remote/device-token";

/**
 * Whether custom tabs can run here: the desktop app only (v1, §1.5). The
 * remote/mobile SPA lists placed tabs but renders a placeholder for each.
 */
export function pluginTabsAvailable(): boolean {
  return isDesktopShell() && !isBrowserRemote();
}
