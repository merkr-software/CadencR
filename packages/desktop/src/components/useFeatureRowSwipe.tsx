import { useContext, type ReactNode, type RefObject } from "react";
import type { Feature } from "@/api/generated";
import { SidebarRowSwipeTray, rowSwipeTrayWidth } from "@/components/SidebarRowSwipeTray";
import { featureSwipeActions } from "@/components/sidebar-row-swipe-actions";
import { ForMeDoneContext } from "@/components/SidebarForMeDoneAction";
import type { SidebarRowActions } from "@/components/SidebarRowActionsProvider";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useIsTouchDevice } from "@/hooks/useIsTouchDevice";
import { useRowSwipe } from "@/hooks/useRowSwipe";
import type { NextActionKind } from "@/lib/next-actions";

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
 * row has no actions (outside a `SidebarRowActionsProvider`). Elsewhere it attaches
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

/**
 * The swipe actions of a conversation shown outside its project (the
 * sidebar's cross-project rows, the phone inbox's cards): Mark done first on a
 * For me entry whose action can be marked (not a request, which is answered),
 * then Pin and Archive. None without a `SidebarRowActionsProvider` above.
 */
export function useCrossProjectRowSwipe(
  rowRef: RefObject<HTMLElement | null>,
  actions: SidebarRowActions | null,
  feature: Feature,
  nextAction: NextActionKind | undefined,
  liveTitle: string | null | undefined,
): FeatureRowSwipe {
  const markDone = useContext(ForMeDoneContext);
  return useFeatureRowSwipe(
    rowRef,
    actions && {
      featureId: feature.id,
      title: liveTitle ?? feature.title,
      isArchived: feature.status === "archived",
      isPinned: feature.is_pinned,
      onTogglePin: actions.togglePin,
      onArchiveOrDelete: () => actions.archiveOrDelete(feature),
      onUnarchive: actions.unarchive,
      onMarkDone: nextAction && nextAction !== "waiting" ? () => markDone(feature.id) : undefined,
    },
  );
}
