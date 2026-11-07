import { useEffect } from "react";
import { toast } from "sonner";
import { useGetGitPathPrefix } from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";

/**
 * The feature directory's prefix inside its checkout (see `lib/git-paths`):
 * `undefined` while loading or after a failure (reported once per feature),
 * `null` without Git metadata.
 */
export function useGitPathPrefix(featureId: number): string | null | undefined {
  const query = useGetGitPathPrefix(
    { feature_id: featureId },
    // Changes only with the feature's directory; worktree changes invalidate it.
    { query: { enabled: featureId > 0, staleTime: Infinity, refetchOnWindowFocus: false } },
  );

  useEffect(() => {
    if (!query.isError) return;
    toast.error("Could not map Git paths to the editor", {
      id: `git-path-prefix-${featureId}`,
      description: apiErrorMessage(query.error, "The project's Git root is unavailable"),
    });
  }, [featureId, query.error, query.isError]);

  return query.data ? (query.data.prefix ?? null) : undefined;
}
