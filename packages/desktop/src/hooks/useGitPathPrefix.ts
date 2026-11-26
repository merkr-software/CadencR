import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { hashKey, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  getGetGitPathPrefixQueryOptions,
  useGetGitPathPrefix,
  type GitPathPrefixResponse,
} from "@/api/generated";
import { scopedToastDescription } from "@/components/ToastScope";
import { apiErrorMessage } from "@/lib/api-errors";
import { gitPathForAgent, keepGitPath, type AgentPathMapper } from "@/lib/git-paths";

function updateGitPathPrefixToast(queryClient: QueryClient, featureId: number): void {
  const options = getGetGitPathPrefixQueryOptions({ feature_id: featureId });
  // A checkout change can replace the cached query while an observer still
  // holds its previous result. Only the current query can update the toast.
  const current = queryClient.getQueryState(options.queryKey);
  const id = `git-path-prefix-${featureId}`;
  if (current?.status === "success") {
    if (toast.getToasts().some((item) => item.id === id)) toast.dismiss(id);
  } else if (current?.status === "error") {
    toast.error("Could not resolve the project's Git paths", {
      id,
      description: scopedToastDescription(
        { featureId },
        apiErrorMessage(current.error, "The project's Git root is unavailable"),
      ),
      duration: Infinity,
      action: {
        label: "Retry",
        onClick: (event) => {
          event.preventDefault();
          const updateToast = () => updateGitPathPrefixToast(queryClient, featureId);
          void queryClient.fetchQuery({ ...options, staleTime: 0 }).then(updateToast, updateToast);
        },
      },
    });
  }
}

function useGitPathPrefixQuery(
  featureId: number,
  enabled = true,
): GitPathPrefixResponse | undefined {
  const queryClient = useQueryClient();
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
  // Removing a query clears stale checkout data without notifying its existing
  // observers. Rebind this observer to the same key when that happens.
  const cache = queryClient.getQueryCache();
  const hash = hashKey(query.queryKey);
  const subscribe = useCallback(
    (notify: () => void) =>
      cache.subscribe((event) => {
        if (event.type === "removed" && event.query.queryHash === hash) notify();
      }),
    [cache, hash],
  );
  const getQuery = useCallback(() => cache.get(hash), [cache, hash]);
  const currentQuery = useSyncExternalStore(subscribe, getQuery);
  const { error, isError, isSuccess } = query;

  useEffect(() => {
    if (isError || isSuccess) updateGitPathPrefixToast(queryClient, featureId);
  }, [currentQuery, error, featureId, isError, isSuccess, queryClient]);

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
