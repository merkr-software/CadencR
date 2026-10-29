import { useContext } from "react";
import { useSidebarAttention } from "@/components/SidebarAttentionProvider";
import { useSidebarCollapsed } from "@/components/SidebarContext";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useForMeShowMore } from "@/hooks/useForMeShowMore";
import { useSidebarSectionExpanded } from "@/hooks/useSidebarSections";
import { useSidebarSample } from "@/lib/sidebar-sample-context";
import { useMostRecentPendingFeatureId } from "@/stores/pending-gate-popover-selectors";
import { useSidebarOption } from "@/stores/sidebar-config-store";
import { useSidebarFilterQuery } from "@/stores/sidebar-filter-store";
import {
  openSidebarGateOwner,
  SidebarSurfaceContext,
  type SidebarSurface,
} from "@/stores/sidebar-surface-store";

/** Whether rows on the caller's surface own the gate popover's auto-open. */
export function useOwnsGateAutoOpen(): boolean {
  const surface = useContext(SidebarSurfaceContext);
  const owner = useGateAutoOpenOwner();
  const sample = useSidebarSample();
  return (sample ? sample.gateOwner : owner) === surface;
}

/**
 * The surface whose rows auto-open a waiting conversation's gate popover. A
 * conversation can show in the rail, "For me" and the tree at once, and only
 * the most prominent one opens: the rail when the sidebar is collapsed behind a
 * conversation rail, else "For me" when it is on screen, else the tree. A
 * collapsed sidebar without a conversation rail opens none: its rows are off
 * screen. Derived from state rather than registered by effects, so every row
 * agrees in the very render a request appears (a popover opening on one
 * surface then closing would steal focus from the one that should stay open).
 * When the newest request sits behind For me's "Show more", the tree opens it.
 */
function useGateAutoOpenOwner(): SidebarSurface | null {
  const { collapsed } = useSidebarCollapsed();
  const isMobile = useIsMobile();
  const rail = useSidebarOption("rail");
  const forMe = useSidebarOption("forMe");
  const filtering = useSidebarFilterQuery() !== "";
  const forMeExpanded = useSidebarSectionExpanded("for-me");
  const newestHidden = useNewestRequestHiddenInForMe();
  if (collapsed && !isMobile) {
    return rail === "conversations" || rail === "attention" ? "rail" : null;
  }
  return openSidebarGateOwner(forMe && forMeExpanded && !newestHidden, filtering);
}

/**
 * Whether the newest pending request is in For me's list but past its limit.
 * One not listed yet (still being looked up) keeps For me as the owner, so the
 * popover doesn't open in the tree only to move once the row arrives.
 */
function useNewestRequestHiddenInForMe(): boolean {
  const newest = useMostRecentPendingFeatureId();
  const { actions } = useSidebarAttention();
  const { visibleCount } = useForMeShowMore(actions.length);
  if (newest == null) return false;
  return actions.findIndex((action) => action.feature.id === newest) >= visibleCount;
}
