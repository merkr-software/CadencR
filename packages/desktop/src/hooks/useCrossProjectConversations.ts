import { useEffect, useMemo } from "react";
import { toast } from "sonner";
import { useListActiveFeatures, type Feature } from "@/api/generated";
import { useSidebarAttention } from "@/components/SidebarAttentionProvider";
import { useMinuteClock } from "@/hooks/useMinuteClock";
import { usePinnedActivity, type PinnedActivity } from "@/hooks/usePinnedActivity";
import { useSidebarFilteredFeatures } from "@/hooks/useSidebarFilteredFeatures";
import { useStableFeatureOrder } from "@/hooks/useStableFeatureOrder";
import { apiErrorMessage } from "@/lib/api-errors";
import type { LensContext } from "@/lib/sidebar-lens";

const NO_FEATURES: Feature[] = [];

export interface CrossProjectConversations {
  /** Every active conversation matching the sidebar filter, last activity first, held steady while agents work. */
  features: readonly Feature[];
  activity: PinnedActivity;
  context: LensContext;
  isPending: boolean;
}

/**
 * The conversations of every project at once, for the lenses that regroup
 * them and for saved views: one request, plus the per-project worktrees (and,
 * for the sidebar's rows, shells) shared with the project sections' cache
 * entries. "sidebar" applies the sidebar filter; "count" (the views' match
 * counts) reads every conversation and polls nothing.
 */
export function useCrossProjectConversations(
  purpose: "sidebar" | "count",
  enabled = true,
): CrossProjectConversations {
  const query = useListActiveFeatures({ query: { enabled } });
  useEffect(() => {
    if (query.error) {
      toast.error(apiErrorMessage(query.error, "Could not load conversations"), {
        id: "sidebar-active-conversations-error",
      });
    }
  }, [query.error]);
  const ordered = useStableFeatureOrder(enabled ? (query.data ?? NO_FEATURES) : NO_FEATURES);
  const activity = usePinnedActivity(ordered, purpose === "sidebar");
  const filtered = useSidebarFilteredFeatures(ordered, activity.worktreeByFeatureId);
  const features = purpose === "sidebar" ? filtered : ordered;
  const { entries } = useSidebarAttention();
  const now = useMinuteClock();
  const context = useMemo<LensContext>(() => {
    const stateById = new Map(entries.map((entry) => [entry.featureId, entry.state]));
    return {
      stateOf: (featureId) => stateById.get(featureId) ?? "idle",
      worktreeOf: (featureId) => activity.worktreeByFeatureId.get(featureId),
      now,
    };
  }, [activity.worktreeByFeatureId, entries, now]);
  return useMemo(
    () => ({ features, activity, context, isPending: enabled && query.isPending }),
    [activity, context, enabled, features, query.isPending],
  );
}
