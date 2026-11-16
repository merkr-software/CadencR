import { useSyncExternalStore } from "react";
import { mediaQueryStore } from "@/lib/media-query";

/**
 * Primary pointer can't hover — phones and tablets. Distinct from
 * `useIsMobile`, which is a viewport-width breakpoint: a narrow desktop window
 * still has a mouse and a right-click.
 */
const TOUCH_QUERY = "(hover: none)";

const touchQuery = mediaQueryStore(TOUCH_QUERY);

/** `true` when the primary input is touch (no hover, no right-click). */
export function useIsTouchDevice(): boolean {
  return useSyncExternalStore(touchQuery.subscribe, touchQuery.getSnapshot, () => false);
}
