import { useQueryClient } from "@tanstack/react-query";
import { getBranch, getGetBranchQueryKey, getStats, getGetStatsQueryKey } from "@/api/generated";
import { useDebouncedCallback, type DebouncedCallback } from "@/hooks/useDebouncedCallback";
import { preloadConversation } from "@/lib/conversation-preload";

/**
 * How long the pointer rests on a row before its conversation is fetched.
 * Shorter than a deliberate hover, longer than a row takes to cross in a
 * cursor sweep down the sidebar.
 */
const PREFETCH_DWELL_MS = 60;

/**
 * Debounced prefetch of what opening a feature row needs: the conversation's
 * first page and layout (`preloadConversation`, the snapshot its workspace
 * opens on), the git branch (per project) and the git stats. Wire onto
 * `onMouseEnter` and `onFocus` so keyboard users get the same warm start (per
 * `keyboard-shortcuts.md`), and its `cancel` onto `onMouseLeave` and `onBlur`.
 *
 * Each row has its own dwell: cancelling it when the pointer leaves is what
 * stops a fast cursor sweep across the sidebar from firing one request per row
 * crossed; a single prefetch lands once the user pauses on a row.
 */
export function useFeaturePrefetch(
  featureId: number | undefined,
  projectId: number | undefined,
): DebouncedCallback<[]> {
  const queryClient = useQueryClient();

  return useDebouncedCallback(() => {
    if (featureId == null) return;
    preloadConversation(featureId);
    // Match the mode ProjectFeatureRow / the Git tab use for working-tree stats
    // ("worktree") so the prefetch warms the same cache entry instead of a
    // separate mode-less key that never gets reused.
    void queryClient.prefetchQuery({
      queryKey: getGetStatsQueryKey({ feature_id: featureId, mode: "worktree" }),
      queryFn: ({ signal }) => getStats({ feature_id: featureId, mode: "worktree" }, signal),
    });
    if (projectId != null) {
      void queryClient.prefetchQuery({
        queryKey: getGetBranchQueryKey({ project_id: projectId }),
        queryFn: ({ signal }) => getBranch({ project_id: projectId }, signal),
      });
    }
  }, PREFETCH_DWELL_MS);
}
