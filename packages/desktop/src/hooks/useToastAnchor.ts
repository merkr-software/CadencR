import { useLayoutEffect, type RefObject } from "react";
import { SIDEBAR_MIN_WIDTH } from "@/lib/sidebar-width";
import { useToastAnchorStore } from "@/stores/toast-anchor-store";

/** Breathing room between the toast stack and the footer's top edge. */
const FOOTER_GAP = 4;

/**
 * While `enabled`, anchors toasts to the sidebar footer: stacked above the
 * footer's top edge (so above the update pill when one shows, else Settings),
 * flush with and as wide as `rowRef`, the Settings row every footer pill
 * shares its width with. The row's parent must be the footer.
 *
 * Re-measures when the footer resizes (an update pill appears, a sidebar drag),
 * when the sidebar resizes (window height) and when its slide-in settles. Below
 * the sidebar's minimum width the panel is mid collapse/expand animation, so
 * nothing is published and toasts keep their fallback placement.
 */
export function useToastAnchor(rowRef: RefObject<HTMLElement | null>, enabled: boolean): void {
  useLayoutEffect(() => {
    const row = rowRef.current;
    const footer = row?.parentElement;
    const sidebar = footer?.closest<HTMLElement>("[data-app-sidebar]");
    if (!enabled || !row || !footer || !sidebar) return;
    const { setAnchor } = useToastAnchorStore.getState();

    const measure = (): void => {
      if (sidebar.getBoundingClientRect().width < SIDEBAR_MIN_WIDTH) {
        setAnchor(null);
        return;
      }
      const rowRect = row.getBoundingClientRect();
      setAnchor({
        bottom: Math.round(window.innerHeight - footer.getBoundingClientRect().top + FOOTER_GAP),
        left: Math.round(rowRect.left),
        width: Math.round(rowRect.width),
      });
    };
    // The slide-in is a transform, which no ResizeObserver sees.
    const onTransitionEnd = (event: TransitionEvent): void => {
      if (event.target === sidebar && event.propertyName === "transform") measure();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(footer);
    observer.observe(sidebar);
    sidebar.addEventListener("transitionend", onTransitionEnd);
    return () => {
      observer.disconnect();
      sidebar.removeEventListener("transitionend", onTransitionEnd);
      setAnchor(null);
    };
  }, [rowRef, enabled]);
}
