/**
 * Query options shared by every sidebar surface reading the same per-project
 * lists (project sections, pinned rows): identical keys and options mean one
 * cache entry and one polling cadence instead of drifting copies.
 */
export const FEATURE_ACTIVITY_POLL_MS = 10_000;
export const FEATURE_WORKTREES_STALE_MS = 5 * 60 * 1000;
export const FEATURE_ACTIVITY_ERROR_TOAST_ID = "sidebar-activity-load-error";

export function featureActivityParams(projectId: number) {
  return { project_id: projectId, include_archived: true } as const;
}
