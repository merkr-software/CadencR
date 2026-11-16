import { useMemo } from "react";
import type { Feature, FeatureWorktreeInfo } from "@/api/generated";
import { useLiveFeatureMeta } from "@/hooks/useLiveFeatureMeta";
import { featureMatchesSidebarFilter, sidebarFilterTerms } from "@/lib/sidebar-filter";
import { useSidebarFilterQuery } from "@/stores/sidebar-filter-store";

/** The conversations matching the sidebar filter, by live title, title, label or branch. */
export function useSidebarFilteredFeatures(
  features: readonly Feature[],
  worktreeByFeatureId: ReadonlyMap<number, FeatureWorktreeInfo>,
): readonly Feature[] {
  const query = useSidebarFilterQuery();
  // Live titles only matter to the filter: no stream subscription while it is off.
  const liveMeta = useLiveFeatureMeta(query !== "");
  return useMemo(() => {
    if (!query) return features;
    const terms = sidebarFilterTerms(query);
    return features.filter((feature) =>
      featureMatchesSidebarFilter(terms, feature, liveMeta, worktreeByFeatureId.get(feature.id)),
    );
  }, [features, liveMeta, query, worktreeByFeatureId]);
}
