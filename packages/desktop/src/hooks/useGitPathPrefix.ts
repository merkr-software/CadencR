import { useEffect, useMemo } from "react";
import { toast } from "sonner";
import { useGetGitPathPrefix, type GitPathPrefixResponse } from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { gitPathForAgent, keepGitPath, type AgentPathMapper } from "@/lib/git-paths";

function useGitPathPrefixQuery(
  featureId: number,
  enabled = true,
): GitPathPrefixResponse | undefined {
  const query = useGetGitPathPrefix(
    { feature_id: featureId },
    // Changes only with the feature's directory; worktree changes invalidate it.
    {
      query: {
        enabled: enabled && featureId > 0,
        staleTime: Infinity,
        refetchOnWindowFocus: false,
      },
    },
  );
  const { refetch } = query;

  useEffect(() => {
    if (!query.isError) return;
    // Opening files from the Git tab, the editor's Git gutter and sending review
    // comments to the agent all wait on these paths, which are never refetched on
    // their own: the toast stays up, explaining the disabled buttons, until retried.
    toast.error("Could not resolve the project's Git paths", {
      id: `git-path-prefix-${featureId}`,
      description: apiErrorMessage(query.error, "The project's Git root is unavailable"),
      duration: Infinity,
      action: { label: "Retry", onClick: () => void refetch() },
    });
  }, [featureId, query.error, query.isError, refetch]);

  return query.data;
}

/**
 * The feature directory's prefix inside its checkout (see `lib/git-paths`):
 * `undefined` while loading or after a failure (reported once per feature),
 * `null` without Git metadata.
 */
export function useGitPathPrefix(featureId: number): string | null | undefined {
  const data = useGitPathPrefixQuery(featureId);
  return data ? (data.prefix ?? null) : undefined;
}

/**
 * Maps the Git tab's repository-relative paths to paths the feature's agent
 * resolves from its working directory. `undefined` while loading or after a
 * failure (reported once per feature, with a retry), so callers hold back what
 * they would send; without Git metadata, paths are kept as they are. `enabled`
 * defers the lookup until something needs sending.
 */
export function useAgentPathMapper(featureId: number, enabled = true): AgentPathMapper | undefined {
  const data = useGitPathPrefixQuery(featureId, enabled);
  return useMemo(() => {
    if (!data) return undefined;
    const { prefix, root } = data;
    if (prefix == null || root == null) return keepGitPath;
    return (gitPath: string) => gitPathForAgent(gitPath, { prefix, root });
  }, [data]);
}
