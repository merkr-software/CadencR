import { useMemo, type RefObject } from "react";

/** The rows a popover is level with: a sidebar row, or a rail tile. */
const ROW_SELECTOR = '[data-nav-type="feature"], [data-sidebar-flash-target]';
/** The panel whose right edge the popover hangs from: the open sidebar or the collapsed rail. */
const EDGE_SELECTOR = "[data-app-sidebar], [data-sidebar-rail]";

interface EdgeAnchor {
  getBoundingClientRect: () => DOMRect;
  /** Lets the popover follow the row when an ancestor scrolls. */
  readonly contextElement: Element | undefined;
}

/**
 * A virtual anchor for a Radix popover: a zero-width strip on the right edge
 * of the sidebar (or rail), as tall as the row holding `triggerRef`. The
 * popover then opens beside the sidebar, level with its row, instead of over
 * the row's own title. Measured only when the popover positions itself.
 */
export function useSidebarEdgeAnchor(
  triggerRef: RefObject<HTMLElement | null>,
): RefObject<EdgeAnchor> {
  return useMemo<RefObject<EdgeAnchor>>(
    () => ({
      current: {
        get contextElement() {
          return triggerRef.current ?? undefined;
        },
        getBoundingClientRect() {
          const trigger = triggerRef.current;
          if (!trigger) return new DOMRect(0, 0, 0, 0);
          const row = trigger.closest(ROW_SELECTOR) ?? trigger;
          const edge = trigger.closest(EDGE_SELECTOR) ?? row;
          const rowRect = row.getBoundingClientRect();
          return new DOMRect(edge.getBoundingClientRect().right, rowRect.top, 0, rowRect.height);
        },
      },
    }),
    [triggerRef],
  );
}
