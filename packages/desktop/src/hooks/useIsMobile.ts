import { useSyncExternalStore } from "react";
import { mediaQueryStore } from "@/lib/media-query";

/**
 * Phone-sized viewport breakpoint. We intentionally treat anything at or below
 * the Tailwind `md` floor (768px) as "mobile" — tablets/iPad are explicitly out
 * of scope, so a single phone breakpoint is all the UI branches on.
 */
const MOBILE_QUERY = "(max-width: 767px)";

const mobileQuery = mediaQueryStore(MOBILE_QUERY);

/**
 * `true` when the viewport is phone-sized. Drives mobile-only layout decisions
 * (drawer sidebar, single tab strip, hidden unified-agents view). SSR-safe via
 * a constant server snapshot — the renderer is client-only so this never flips.
 */
export function useIsMobile(): boolean {
  return useSyncExternalStore(mobileQuery.subscribe, mobileQuery.getSnapshot, () => false);
}

/** The same answer read once, for code outside React (palette command lists). */
export function isMobileViewport(): boolean {
  return mobileQuery.getSnapshot();
}
