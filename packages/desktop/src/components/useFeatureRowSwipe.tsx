import type { ReactNode, RefObject } from "react";
import { SidebarRowSwipeTray, rowSwipeTrayWidth } from "@/components/SidebarRowSwipeTray";
import { featureSwipeActions } from "@/components/sidebar-row-swipe-actions";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useIsTouchDevice } from "@/hooks/useIsTouchDevice";
import { useRowSwipe } from "@/hooks/useRowSwipe";

type FeatureSwipeInput = Parameters<typeof featureSwipeActions>[0];

interface FeatureRowSwipe {
  /**
   * The phone layout under a finger: the row's hover actions give way to the
   * swipe tray. A narrow window with a mouse keeps its hover actions.
   */
  swipes: boolean;
  /** Spread on the row: marks it as a swiping row (`touch-action: pan-y`). */
  rowProps: { "data-row-swipe-row"?: "" };
  /** The tray, rendered as the row's last child; null when the row doesn't swipe. */
  tray: ReactNode;
}

/**
 * A conversation row's swipe actions in the phone layout on a touch screen:
 * the gesture on the row element and the tray it reveals. `input` null: the
 * row has no actions (rendered outside the sidebar). Elsewhere it attaches
 * nothing.
 */
export function useFeatureRowSwipe(
  ref: RefObject<HTMLElement | null>,
  input: FeatureSwipeInput | null,
): FeatureRowSwipe {
  const phone = useIsMobile();
  const touch = useIsTouchDevice();
  const actions = phone && touch && input ? featureSwipeActions(input) : null;
  const swipe = useRowSwipe({
    ref,
    enabled: actions !== null,
    trayWidth: actions ? rowSwipeTrayWidth(actions) : 0,
  });
  if (!actions || !input) return { swipes: false, rowProps: {}, tray: null };
  return {
    swipes: true,
    rowProps: { "data-row-swipe-row": "" },
    tray: <SidebarRowSwipeTray featureId={input.featureId} swipe={swipe} actions={actions} />,
  };
}
