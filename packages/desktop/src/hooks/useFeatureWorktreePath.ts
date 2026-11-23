import { useMemo } from "react";
import { useListFeatureWorktrees, type FeatureWorktreeInfo } from "@/api/generated";
import { FEATURE_WORKTREES_STALE_MS } from "@/lib/sidebar-queries";

interface FeatureWorktreeState {
  worktree: FeatureWorktreeInfo | undefined;
  isResolved: boolean;
  isLoading: boolean;
  error: unknown;
}

/**
 * Worktree path for a feature, or `null` when the feature works directly in
 * the project root. Backed by the project worktree-health endpoint so a
 * leftover directory that Git no longer recognizes is never returned as a
 * usable worktree.
 */
export function useFeatureWorktreeInfo(
  featureId: number,
  projectId: number,
  enabled = true,
): FeatureWorktreeState {
  const query = useListFeatureWorktrees(
    { project_id: projectId },
    { query: { enabled, staleTime: FEATURE_WORKTREES_STALE_MS } },
  );
  const worktree = useMemo(
    () => query.data?.find((item) => item.feature_id === featureId),
    [featureId, query.data],
  );
  return useMemo(
    () => ({
      worktree,
      isResolved: query.data != null,
      isLoading: query.isLoading,
      error: query.error ?? null,
    }),
    [query.data, query.error, query.isLoading, worktree],
  );
}

export function useFeatureWorktreePath(
  featureId: number,
  projectId: number,
): string | null | undefined {
  const { worktree, isResolved } = useFeatureWorktreeInfo(featureId, projectId);
  if (!isResolved) return undefined;
  return worktree?.live ? worktree.worktree_path : null;
}
