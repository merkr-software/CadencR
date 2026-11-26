import { useMemo } from "react";
import { useGetStats } from "@/api/generated";
import { selectGitMissingTargetBranch, useGitStatusStore } from "@/stores/useGitStatusStore";
import type { GitTabToolbarProps } from "./GitTabToolbar";
import type { GitViewMode } from "./GitTabToggle";
import type { DiffMode } from "./useDiffData";

export interface GitTabPanes {
  /** Views that drive their own list body and per-row stats. */
  isListView: boolean;
  isPr: boolean;
  diffMode: DiffMode;
  diffTargetBranch: string | undefined;
  stats: GitTabToolbarProps["stats"];
}

/**
 * Translates the active sub-view into the parameters the diff endpoints want,
 * and fetches the diff-wide stat line the toolbar shows.
 */
export function useGitTabPanes(
  featureId: number,
  viewMode: GitViewMode,
  targetBranch: string | undefined,
): GitTabPanes {
  const unresolvedTargetBranch = useGitStatusStore(selectGitMissingTargetBranch(featureId));
  const isPr = viewMode === "pr";
  const isListView =
    isPr || viewMode === "graph" || viewMode === "branches" || viewMode === "stashes";
  // "uncommitted" hits the working-tree path on the server (an alias of the
  // legacy "worktree" mode); "vs-target" pins the diff to the resolved branch.
  const diffMode: DiffMode = viewMode === "vs-target" ? "branch" : "uncommitted";
  const diffTargetBranch = viewMode === "vs-target" ? targetBranch : undefined;
  // Every read against a target that does not exist would fail the same way:
  // the view states it once (see `GitTabBody`) instead of asking.
  const missingTargetBranch = viewMode === "vs-target" ? unresolvedTargetBranch : undefined;
  // Stats are byte-identical for "worktree" and "uncommitted" on the backend,
  // so label the working-tree query "worktree" — the value ProjectFeatureRow and
  // the prefetch use — to share one cache entry instead of firing a duplicate
  // under the "uncommitted" key while the Git tab is open.
  const statsQuery = useGetStats(
    {
      feature_id: featureId,
      mode: viewMode === "vs-target" ? "branch" : "worktree",
      target_branch: diffTargetBranch,
    },
    // The list views carry their own per-row stats, so skip the request.
    { query: { enabled: !isListView && missingTargetBranch === undefined } },
  );
  const partial = (statsQuery.data?.unavailable_line_counts ?? 0) > 0;

  return useMemo(
    () => ({
      isListView,
      isPr,
      diffMode,
      diffTargetBranch,
      stats: {
        isLoading: statsQuery.isLoading,
        isError: statsQuery.isError,
        // No target to diff against: no figures, rather than a made-up "+0 −0"
        // or a second, red message beside the view's own.
        hidden: missingTargetBranch !== undefined,
        additions: statsQuery.data?.insertions,
        deletions: statsQuery.data?.deletions,
        partial,
      },
    }),
    [
      diffMode,
      diffTargetBranch,
      isListView,
      isPr,
      statsQuery.data?.deletions,
      statsQuery.data?.insertions,
      statsQuery.isError,
      statsQuery.isLoading,
      missingTargetBranch,
      partial,
    ],
  );
}
