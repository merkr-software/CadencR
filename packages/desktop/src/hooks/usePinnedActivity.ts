import { useEffect, useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  type AllocatedPort,
  getListFeatureActivityQueryOptions,
  getListFeatureWorktreesQueryOptions,
  type Feature,
  type FeatureActivity,
  type FeatureWorktreeInfo,
} from "@/api/generated";
import { NO_PORTS } from "@/hooks/useFeaturePorts";
import { apiErrorMessage } from "@/lib/api-errors";
import {
  FEATURE_ACTIVITY_ERROR_TOAST_ID,
  FEATURE_ACTIVITY_POLL_MS,
  FEATURE_WORKTREES_STALE_MS,
  featureActivityParams,
} from "@/lib/sidebar-queries";

interface QueryResult<T> {
  data?: T;
  error: unknown;
}

// Module-level so TanStack can memoize the combined result between renders.
function combineActivity(results: QueryResult<FeatureActivity[]>[]) {
  return {
    error: results.find((result) => result.error)?.error ?? null,
    counts: new Map(
      results.flatMap((result) =>
        (result.data ?? []).map((item) => [item.feature_id, item.shell_count] as const),
      ),
    ),
  };
}

function combineWorktrees(results: QueryResult<FeatureWorktreeInfo[]>[]) {
  const worktrees = results.flatMap((result) => result.data ?? []);
  return {
    error: results.find((result) => result.error)?.error ?? null,
    live: new Set(worktrees.filter((worktree) => worktree.live).map((w) => w.feature_id)),
    byFeatureId: new Map(worktrees.map((worktree) => [worktree.feature_id, worktree] as const)),
  };
}

export interface PinnedActivity {
  shellCountByFeatureId: ReadonlyMap<number, number>;
  liveWorktreeFeatureIds: ReadonlySet<number>;
  worktreeByFeatureId: ReadonlyMap<number, FeatureWorktreeInfo>;
}

/**
 * Shell counts and worktrees for rows outside their project (Pinned, the For
 * me, In progress and Recent blocks, the lenses): one activity and one
 * worktrees query per distinct project, with the project sections' keys and
 * options so an expanded project shares the same cache entries. Without
 * `withShells`, only worktrees: no activity polling.
 */
export function usePinnedActivity(pinned: readonly Feature[], withShells = true): PinnedActivity {
  const projectIds = useMemo(
    () => [...new Set(pinned.map((feature) => feature.project_id))].sort((a, b) => a - b),
    [pinned],
  );
  const activity = useQueries({
    queries: (withShells ? projectIds : []).map((projectId) =>
      getListFeatureActivityQueryOptions(featureActivityParams(projectId), {
        query: { refetchInterval: FEATURE_ACTIVITY_POLL_MS },
      }),
    ),
    combine: combineActivity,
  });
  const worktrees = useQueries({
    queries: projectIds.map((projectId) =>
      getListFeatureWorktreesQueryOptions(
        { project_id: projectId },
        { query: { staleTime: FEATURE_WORKTREES_STALE_MS } },
      ),
    ),
    combine: combineWorktrees,
  });

  useEffect(() => {
    if (!activity.error) return;
    toast.error(apiErrorMessage(activity.error, "Failed to load sidebar activity"), {
      id: FEATURE_ACTIVITY_ERROR_TOAST_ID,
    });
  }, [activity.error]);
  useEffect(() => {
    if (!worktrees.error) return;
    toast.error(apiErrorMessage(worktrees.error, "Failed to load worktrees"), {
      id: "sidebar-worktrees-load-error",
    });
  }, [worktrees.error]);

  return useMemo(
    () => ({
      shellCountByFeatureId: activity.counts,
      liveWorktreeFeatureIds: worktrees.live,
      worktreeByFeatureId: worktrees.byFeatureId,
    }),
    [activity.counts, worktrees.live, worktrees.byFeatureId],
  );
}

/** What a row outside its project shows of it, as the tree's rows do: ports, shells, worktree. */
export function crossProjectRowData(
  activity: PinnedActivity,
  portsByFeatureId: ReadonlyMap<number, readonly AllocatedPort[]>,
  featureId: number,
): {
  ports: readonly AllocatedPort[];
  shellCount: number;
  hasLiveWorktree: boolean;
  worktree: FeatureWorktreeInfo | undefined;
} {
  return {
    ports: portsByFeatureId.get(featureId) ?? NO_PORTS,
    shellCount: activity.shellCountByFeatureId.get(featureId) ?? 0,
    hasLiveWorktree: activity.liveWorktreeFeatureIds.has(featureId),
    worktree: activity.worktreeByFeatureId.get(featureId),
  };
}
