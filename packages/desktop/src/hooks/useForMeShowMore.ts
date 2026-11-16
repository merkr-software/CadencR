import { useMemo } from "react";
import { forMeVisibleCount } from "@/lib/next-actions";
import { useSidebarOption } from "@/stores/sidebar-config-store";
import { useSidebarSurfaceStore } from "@/stores/sidebar-surface-store";

export interface ShowMore {
  /** How many of the list's items show right now. */
  visibleCount: number;
  /** How many the limit leaves out (whether shown for now or not): 0 when all fit. */
  hiddenCount: number;
  expanded: boolean;
  toggle: () => void;
}

/**
 * The "For me" block's limit (3, 5 or all of its actions) and its "Show more"
 * state, shared by the live block and the display options preview. The state
 * lives in the surface store: the gate popover's owner reads it too.
 */
export function useForMeShowMore(total: number): ShowMore {
  const limit = useSidebarOption("forMeLimit");
  const expanded = useSidebarSurfaceStore((state) => state.forMeShowAll);
  const toggle = useSidebarSurfaceStore((state) => state.toggleForMeShowAll);
  const hiddenCount = total - forMeVisibleCount(total, limit, false);
  const visibleCount = forMeVisibleCount(total, limit, expanded);
  return useMemo(
    () => ({ visibleCount, hiddenCount, expanded, toggle }),
    [expanded, hiddenCount, toggle, visibleCount],
  );
}
