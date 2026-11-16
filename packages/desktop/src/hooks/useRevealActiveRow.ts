import { useEffect, type RefObject } from "react";
import { useSidebarOption } from "@/stores/sidebar-config-store";

/** Frames to wait for the row to mount (its project may expand and fetch first). */
const MAX_FRAMES = 90;

/**
 * Scrolls the open conversation's row into view in the project tree when it
 * changes (K1, "scroll" mode), however it was opened: ⌘K, a notification, the
 * "next waiting" shortcut. `nearest` leaves a row already on screen alone, so
 * clicking a visible row never moves the list. Virtualized lists reveal their
 * own active row.
 */
export function useRevealActiveRow(
  treeRef: RefObject<HTMLElement | null>,
  activeFeatureId: number | null,
): void {
  const mode = useSidebarOption("revealActive");
  useEffect(() => {
    if (mode !== "scroll" || activeFeatureId == null) return;
    let frame = 0;
    let handle = 0;
    const reveal = (): void => {
      const row = treeRef.current?.querySelector<HTMLElement>(
        `[data-nav-type="feature"][data-nav-id="${activeFeatureId}"]`,
      );
      if (row) {
        row.scrollIntoView({ block: "nearest" });
        return;
      }
      if (++frame < MAX_FRAMES) handle = requestAnimationFrame(reveal);
    };
    handle = requestAnimationFrame(reveal);
    return () => cancelAnimationFrame(handle);
  }, [activeFeatureId, mode, treeRef]);
}
