import { toast } from "sonner";
import { z } from "zod";
import type { QueryClient } from "@tanstack/react-query";
import { scopedToastDescription } from "@/components/ToastScope";
import { WORKTREE_UNAVAILABLE } from "@/lib/api-errors";
import type { GitStatusHealth } from "./useGitStatusStore";

export const statusHealthSchema = z.object({
  feature_id: z.number(),
  error: z.string().min(1).optional(),
  code: z.string().optional(),
  watcher_error: z.string().min(1).nullable().optional(),
});

const issues = [
  { field: "statusError", prefix: "git-status-error", title: "Git status error" },
  { field: "watcherError", prefix: "git-watcher-error", title: "Git live updates unavailable" },
] as const;

export function notifyGitStatusHealth(
  featureId: number,
  previous: GitStatusHealth | undefined,
  next: GitStatusHealth | undefined,
): void {
  for (const { field, prefix, title } of issues) {
    const error = next?.[field];
    if (error === previous?.[field]) continue;
    const id = `${prefix}-${featureId}`;
    if (error) {
      const label =
        field === "statusError" && next?.statusErrorCode === WORKTREE_UNAVAILABLE
          ? "Worktree unavailable"
          : title;
      toast.error(label, { id, description: scopedToastDescription({ featureId }, error) });
    } else {
      toast.dismiss(id);
    }
  }
}

export const GIT_CONTENT_INVALIDATION_PREFIXES = [
  "/api/git/changed-files",
  "/api/git/diff",
  "/api/git/file-diff",
  "/api/git/file-blob-shas",
  "/api/git/stats",
  "/api/git/stashes",
  "/api/git/uncommitted-files",
  "/api/git/has-uncommitted-changes",
] as const;

// The graph reads every loaded page. Refresh it when history moves.
export const GIT_HISTORY_INVALIDATION_PREFIXES = [
  "/api/git/commit-log",
  "/api/git/commit-graph",
] as const;

export const GIT_STATUS_INVALIDATION_PREFIXES = [
  ...GIT_CONTENT_INVALIDATION_PREFIXES,
  ...GIT_HISTORY_INVALIDATION_PREFIXES,
] as const;

export function queryParamsMatchFeature(params: unknown, featureId: number): boolean {
  return (
    params != null &&
    typeof params === "object" &&
    "feature_id" in params &&
    params.feature_id === featureId
  );
}

export function gitQueryFilter(featureId: number, prefixes: readonly string[]) {
  return {
    predicate: ({ queryKey }: { queryKey: readonly unknown[] }) => {
      const [url, params] = queryKey;
      return (
        typeof url === "string" &&
        prefixes.some((prefix) => url.startsWith(prefix)) &&
        queryParamsMatchFeature(params, featureId)
      );
    },
  };
}

/** Old checkout data cannot seed the recovered view or retire review comments. */
export function clearGitCheckoutQueries(queryClient: QueryClient, featureId: number): void {
  queryClient.removeQueries(
    gitQueryFilter(featureId, [
      ...GIT_STATUS_INVALIDATION_PREFIXES,
      "/api/git/file-content",
      "/api/git/path-prefix",
    ]),
  );
}
