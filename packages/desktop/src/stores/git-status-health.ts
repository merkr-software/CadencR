import { toast } from "sonner";
import { z } from "zod";
import type { QueryClient } from "@tanstack/react-query";
import { scopedToastDescription } from "@/components/ToastScope";
import { WORKTREE_UNAVAILABLE, worktreeUnavailableMessage } from "@/lib/api-errors";
import { localizedToastText } from "@/lib/i18n/toast-text";
import { translateUi } from "@/lib/i18n/ui";
import type { GitStatusHealth } from "./useGitStatusStore";

export const statusHealthSchema = z.object({
  feature_id: z.number(),
  error: z.string().min(1).optional(),
  code: z.string().optional(),
  watcher_error: z.string().min(1).nullable().optional(),
});

const issues = [
  { field: "statusError", prefix: "git-status-error" },
  { field: "watcherError", prefix: "git-watcher-error" },
] as const;

export function notifyGitStatusHealth(
  featureId: number,
  previous: GitStatusHealth | undefined,
  next: GitStatusHealth | undefined,
): void {
  for (const { field, prefix } of issues) {
    const error = next?.[field];
    if (error === previous?.[field]) continue;
    const id = `${prefix}-${featureId}`;
    if (error) {
      const unavailable = field === "statusError" && next?.statusErrorCode === WORKTREE_UNAVAILABLE;
      const label = unavailable
        ? translateUi("workspace.git.status.worktreeUnavailable", "Worktree unavailable")
        : field === "watcherError"
          ? translateUi(
              "workspace.git.status.liveUpdatesUnavailable",
              "Git live updates unavailable",
            )
          : translateUi("workspace.git.wsGitStatusHandler.gitStatusError", "Git status error");
      const detail = unavailable ? localizedToastText(worktreeUnavailableMessage) : error;
      toast.error(label, { id, description: scopedToastDescription({ featureId }, detail) });
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
