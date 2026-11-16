import { invalidateByUrlPrefix, queryClient } from "@/lib/queryClient";

const WORKTREE_QUERY_PREFIXES = [
  "/api/git/feature-worktrees",
  "/api/git/worktrees",
  "/api/git/path-prefix",
] as const;

export function invalidateWorktreeQueries(): void {
  void invalidateByUrlPrefix(queryClient, WORKTREE_QUERY_PREFIXES);
}
