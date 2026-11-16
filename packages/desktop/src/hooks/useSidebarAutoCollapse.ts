import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { mediaQueryStore } from "@/lib/media-query";
import { useSidebarOption } from "@/stores/sidebar-config-store";

/** Below this window width the sidebar folds itself away when "Auto-collapse" is on. */
export const SIDEBAR_AUTO_COLLAPSE_QUERY = "(max-width: 1023px)";

const narrowQuery = mediaQueryStore(SIDEBAR_AUTO_COLLAPSE_QUERY);

function subscribeNever(): () => void {
  return () => {};
}

function getFalse(): boolean {
  return false;
}

/**
 * A8: whether a narrow window is folding the sidebar away right now, and the
 * hook for the user's own toggles. Never persisted: widening the window brings
 * the sidebar back as it was. Expanding it while narrow wins until the window
 * widens again; collapsing it then just hands it back to the auto fold.
 */
export function useSidebarAutoCollapse(isMobile: boolean): {
  autoCollapsed: boolean;
  /** Called with every user toggle; returns true when it handled the toggle alone. */
  onUserToggle: (nextCollapsed: boolean) => boolean;
} {
  const enabled = useSidebarOption("autoCollapse") && !isMobile;
  const narrow = useSyncExternalStore(
    enabled ? narrowQuery.subscribe : subscribeNever,
    enabled ? narrowQuery.getSnapshot : getFalse,
    getFalse,
  );
  const [expandedWhileNarrow, setExpandedWhileNarrow] = useState(false);
  // Widening ends the user's override; reset while rendering, not in an effect.
  if (!narrow && expandedWhileNarrow) setExpandedWhileNarrow(false);
  const autoCollapsed = narrow && !expandedWhileNarrow;

  const onUserToggle = useCallback(
    (nextCollapsed: boolean): boolean => {
      if (!narrow) return false;
      setExpandedWhileNarrow(!nextCollapsed);
      // Expanding still clears a stored collapse; collapsing stays unstored.
      return nextCollapsed;
    },
    [narrow],
  );
  return useMemo(() => ({ autoCollapsed, onUserToggle }), [autoCollapsed, onUserToggle]);
}
