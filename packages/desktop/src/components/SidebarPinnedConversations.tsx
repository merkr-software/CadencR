import type { FeatureNavigateOptions } from "@/lib/feature-focus-handoff";
import { useCallback, useMemo, useRef, type ReactElement } from "react";
import { PinIcon } from "lucide-react";
import { useListPinnedFeatures, type Feature } from "@/api/generated";
import { PinnedConversationRow } from "@/components/PinnedConversationRow";
import { SidebarBlock } from "@/components/SidebarBlock";
import { useSidebarAttention } from "@/components/SidebarAttentionProvider";
import { isStrongAttention } from "@/lib/sidebar-attention";
import { useSidebarOption } from "@/stores/sidebar-config-store";
import { useCrossProjectNavigate } from "@/hooks/useCrossProjectNavigate";
import { skipProjectAutoExpand } from "@/lib/project-auto-expand";
import { useReorderAnimation } from "@/hooks/useReorderAnimation";
import { useStableFeatureOrder } from "@/hooks/useStableFeatureOrder";
import { useManualConversationOrder } from "@/hooks/useManualConversationOrder";
import { sortByManualOrder } from "@/lib/sidebar-manual-order";
import { SidebarReorderProvider } from "@/components/SidebarReorderProvider";
import { useFeaturePorts } from "@/hooks/useFeaturePorts";
import { crossProjectRowData, usePinnedActivity } from "@/hooks/usePinnedActivity";
import { useSidebarFilteredFeatures } from "@/hooks/useSidebarFilteredFeatures";
import { useSidebarFilterQuery } from "@/stores/sidebar-filter-store";
import { useSidebarSectionFold } from "@/hooks/useSidebarSections";

/**
 * Global "Pinned" section rendered above the project list. Pinning is a
 * feature-level concept (`features.is_pinned`), so a single backend query
 * returns every pinned conversation across all projects — each row carries its
 * project color dot so the user can tell them apart at a glance. Renders
 * nothing when no conversation is pinned, unless empty blocks are kept.
 *
 * Unpinning here (the sidebar's row actions) and pinning from a project row
 * both write the same column and invalidate the `/api/features` cache prefix
 * (which covers this list); there is no optimistic state — the section
 * re-renders from the refetched data.
 */
const EMPTY_FEATURES: Feature[] = [];

export function SidebarPinnedConversations({
  activeFeatureId,
  onSelectFeature,
}: {
  activeFeatureId: number | null;
  onSelectFeature: (featureId: number) => void;
}): ReactElement | null {
  const { data: fetchedPinned = EMPTY_FEATURES } = useListPinnedFeatures();
  const orderedPinned = usePinnedOrder(fetchedPinned);
  const activity = usePinnedActivity(fetchedPinned);
  const pinnedFeatures = useSidebarFilteredFeatures(orderedPinned, activity.worktreeByFeatureId);
  const listRef = useRef<HTMLElement>(null);
  const pinnedIds = useMemo(() => pinnedFeatures.map((feature) => feature.id), [pinnedFeatures]);
  useReorderAnimation(listRef, pinnedIds);
  const reorderGroups = useMemo(() => [pinnedIds], [pinnedIds]);
  const portsByFeatureId = useFeaturePorts();
  const crossProjectNavigate = useCrossProjectNavigate(activeFeatureId, onSelectFeature);
  // Opening from the pinned section must not unfold the parent project.
  const handleNavigate = useCallback(
    (feature: Feature, options?: FeatureNavigateOptions): void => {
      skipProjectAutoExpand(feature.project_id);
      crossProjectNavigate(feature, options);
    },
    [crossProjectNavigate],
  );
  const hideEmpty = useSidebarOption("hideEmptyBlocks");
  const filtering = useSidebarFilterQuery() !== "";
  const fold = useSidebarSectionFold("pinned");
  const strongCount = usePinnedStrongCount(pinnedFeatures);

  const isEmpty = pinnedFeatures.length === 0;
  // An empty Pinned block only shows when empty blocks are kept and nothing is filtered out.
  if (isEmpty && (hideEmpty || filtering)) return null;

  return (
    <SidebarBlock
      ref={listRef}
      block="pinned"
      label="Pinned"
      icon={PinIcon}
      count={pinnedFeatures.length}
      // Pinned rows show nowhere else: a folded block still flags who waits on the user.
      strongCount={strongCount}
      fold={fold}
      empty="Pin a conversation to keep it here"
      isEmpty={isEmpty}
      capped
    >
      <SidebarReorderProvider groups={reorderGroups}>
        {pinnedFeatures.map((feature) => (
          <PinnedConversationRow
            key={feature.id}
            feature={feature}
            activeFeatureId={activeFeatureId}
            {...crossProjectRowData(activity, portsByFeatureId, feature.id)}
            onNavigate={handleNavigate}
            showUnpin
          />
        ))}
      </SidebarReorderProvider>
    </SidebarBlock>
  );
}

/**
 * Pinned rows hold their place while agents work, like the tree; under the
 * manual sort they follow the rank dragged into place instead (the other
 * sorts never applied here: Pinned is the user's own shortlist).
 */
function usePinnedOrder(fetched: readonly Feature[]): readonly Feature[] {
  const stable = useStableFeatureOrder(fetched);
  const manual = useSidebarOption("conversationSort") === "manual";
  const manualOrder = useManualConversationOrder();
  return useMemo(
    () => (manual ? sortByManualOrder(stable, manualOrder) : stable),
    [manual, manualOrder, stable],
  );
}

/** How many pinned conversations need an action (a request waiting, a failure). */
function usePinnedStrongCount(pinned: readonly Feature[]): number {
  const { queue } = useSidebarAttention();
  return useMemo(() => {
    const strongIds = new Set(
      queue.filter((item) => isStrongAttention(item.state)).map((item) => item.feature.id),
    );
    return pinned.filter((feature) => strongIds.has(feature.id)).length;
  }, [pinned, queue]);
}
