import { useGetStats, type Feature, type GitStats, type PrStatusSnapshot } from "@/api/generated";
import { useFeaturePrefetch } from "@/hooks/useFeaturePrefetch";
import { useFeatureAttention } from "@/hooks/useFeatureAttention";
import type { Attention } from "@/lib/sidebar-attention";
import { selectPrStatus, usePrStatusStore } from "@/stores/usePrStatusStore";
import { useIsSidebarPointedFeature } from "@/stores/sidebar-pointed-feature-store";

export interface ProjectFeatureRowState {
  attention: Attention;
  prStatus: PrStatusSnapshot | undefined;
  gitStats: GitStats | undefined;
  isActive: boolean;
  isArchived: boolean;
  isPinned: boolean;
  /** Pointed at from elsewhere (an agent message's sender): the row lights up. */
  isPointed: boolean;
  prefetchFeature: () => void;
}

/**
 * Everything a sidebar feature row derives from stores and queries, kept out of
 * the component so its render stays readable.
 *
 * Returns a plain literal rather than a memo: the row destructures it on the
 * spot and passes the individual values down, so no `React.memo` downstream
 * ever observes the object's identity.
 */
export function useProjectFeatureRowState(
  feature: Feature,
  projectId: number,
  activeFeatureId: number | null,
  hasLiveWorktree: boolean,
  /** Conversations folded under this row; their most urgent state shows here. */
  hiddenDescendantIds?: readonly number[],
): ProjectFeatureRowState {
  // Pending request > working > unread reply > idle, across the row and any
  // collapsed children. Subscribes to just those ids, so another
  // conversation's status push doesn't re-render this row.
  const attention = useFeatureAttention(feature.id, hiddenDescendantIds);
  const prStatus = usePrStatusStore(selectPrStatus(feature.id));
  const isActive = activeFeatureId === feature.id;
  const { data: gitStats } = useGetStats(
    { feature_id: feature.id, mode: "worktree" },
    {
      query: {
        // Limit fan-out: fetch only for live worktrees or the active row (which
        // the Git tab is already fetching). Other rows reuse the cache.
        enabled: hasLiveWorktree || isActive,
        refetchInterval: 5 * 60 * 1000,
        retry: false,
      },
    },
  );
  const prefetchFeature = useFeaturePrefetch(feature.id, projectId);
  const isPointed = useIsSidebarPointedFeature(feature.id);

  return {
    attention,
    prStatus,
    gitStats,
    isActive,
    isArchived: feature.status === "archived",
    isPinned: feature.is_pinned,
    isPointed,
    prefetchFeature,
  };
}
