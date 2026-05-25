/**
 * WS dispatcher for `domain="git"` envelopes (action: `status` and
 * `status_error`). Lives next to `session-status-store.ts` because the same
 * app-level WebSocket carries both — but extracted to keep the store under
 * the 400-line cap.
 *
 * Per `no-optimistic-updates.md`, the `useGitStatusStore` mutates only on
 * these envelopes. Per `error-handling.md`, `status_error` surfaces a toast
 * and never silently no-ops.
 */
import { toast } from "sonner";
import type { GitStatusSnapshot } from "@/api/generated";
import { queryClient } from "@/lib/queryClient";
import { gitStatusSnapshotsEqual, useGitStatusStore } from "@/stores/useGitStatusStore";
import { useCommitOutputStore } from "@/stores/useCommitOutputStore";
import { usePushOutputStore } from "@/stores/usePushOutputStore";

/** URL prefixes for every cached query that may need refreshing when a
 *  worktree's git state changes. Orval keys all start with the URL string.
 *
 *  `/api/git/status` is intentionally absent: the WS push has already updated
 *  `useGitStatusStore` (the source of truth for live status), and re-fetching
 *  the HTTP one-shot would race the WS push and cause the branch chip to
 *  flicker — the HTTP response computed at T can land after a WS push
 *  computed at T+Δ. The HTTP query is only used for first-paint hydration. */
const GIT_STATUS_INVALIDATION_PREFIXES = [
  "/api/git/changed-files",
  "/api/git/commit-log",
  "/api/git/diff",
  "/api/git/file-blob-shas",
  "/api/git/stats",
  "/api/git/uncommitted-files",
  "/api/git/has-uncommitted-changes",
] as const;

const GIT_CONTENT_INVALIDATION_PREFIXES = [
  "/api/git/changed-files",
  "/api/git/diff",
  "/api/git/file-blob-shas",
  "/api/git/stats",
  "/api/git/uncommitted-files",
  "/api/git/has-uncommitted-changes",
] as const;

export function handleGitEnvelope(action: string, payload: Record<string, unknown>): void {
  if (action === "status") {
    const snapshot = parseGitStatusSnapshot(payload);
    if (!snapshot) return;
    const existing = useGitStatusStore.getState().byFeature[snapshot.feature_id];
    const prefixes = getGitInvalidationPrefixes(existing, snapshot);
    useGitStatusStore.getState().setStatus(snapshot);
    if (prefixes.length > 0) void invalidateGitQueriesForFeature(snapshot.feature_id, prefixes);
    return;
  }
  if (action === "status_error") {
    const featureId = typeof payload.feature_id === "number" ? payload.feature_id : null;
    const error = typeof payload.error === "string" ? payload.error : null;
    if (featureId == null || !error) return;
    useGitStatusStore.getState().setStatusError({ feature_id: featureId, error });
    toast.error(`Git status error: ${error}`);
    return;
  }
  // Streaming commit lifecycle: drives the commit dialog's terminal pane
  // (see `useCommitOutputStore`). Each line is broadcast verbatim so the
  // dialog can render pre-commit-hook output as it happens.
  if (action === "commit.start") {
    const featureId = typeof payload.feature_id === "number" ? payload.feature_id : null;
    if (featureId == null) return;
    useCommitOutputStore.getState().start(featureId);
    return;
  }
  if (action === "commit.output") {
    const featureId = typeof payload.feature_id === "number" ? payload.feature_id : null;
    // Backend ships raw PTY chunks under `text`; older senders may emit
    // a single `line` field — handle both for forward-compatibility.
    const text =
      typeof payload.text === "string"
        ? payload.text
        : typeof payload.line === "string"
          ? `${payload.line}\n`
          : null;
    if (featureId == null || text == null) return;
    useCommitOutputStore.getState().append(featureId, text);
    return;
  }
  if (action === "commit.complete") {
    const featureId = typeof payload.feature_id === "number" ? payload.feature_id : null;
    if (featureId == null) return;
    useCommitOutputStore.getState().complete(featureId);
    return;
  }
  // Push lifecycle: identical shape to commit, but routed to its own store
  // so concurrent commit + push (across features) don't trample each other.
  // Prompt detection happens in the dialog from the streamed buffer; the
  // backend just forwards raw PTY chunks here.
  if (action === "push.start") {
    const featureId = typeof payload.feature_id === "number" ? payload.feature_id : null;
    if (featureId == null) return;
    usePushOutputStore.getState().start(featureId);
    return;
  }
  if (action === "push.output") {
    const featureId = typeof payload.feature_id === "number" ? payload.feature_id : null;
    const text =
      typeof payload.text === "string"
        ? payload.text
        : typeof payload.line === "string"
          ? `${payload.line}\n`
          : null;
    if (featureId == null || text == null) return;
    usePushOutputStore.getState().append(featureId, text);
    return;
  }
  if (action === "push.complete") {
    const featureId = typeof payload.feature_id === "number" ? payload.feature_id : null;
    if (featureId == null) return;
    usePushOutputStore.getState().complete(featureId);
  }
}

function getGitInvalidationPrefixes(
  existing: GitStatusSnapshot | undefined,
  snapshot: GitStatusSnapshot,
): readonly string[] {
  if (!existing) return [];
  if (existing.computed_at > snapshot.computed_at) return [];
  if (!gitStatusSnapshotsEqual(existing, snapshot)) return GIT_STATUS_INVALIDATION_PREFIXES;
  if (snapshot.computed_at > existing.computed_at) return GIT_CONTENT_INVALIDATION_PREFIXES;
  return [];
}

function invalidateGitQueriesForFeature(
  featureId: number,
  prefixes: readonly string[],
): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: (query) => {
      const head = query.queryKey[0];
      if (typeof head !== "string") return false;
      if (!prefixes.some((prefix) => head.startsWith(prefix))) return false;
      return queryParamsMatchFeature(query.queryKey[1], featureId);
    },
  });
}

function queryParamsMatchFeature(params: unknown, featureId: number): boolean {
  if (params == null || typeof params !== "object") return false;
  if (!("feature_id" in params)) return false;
  return params.feature_id === featureId;
}

export function parseGitStatusSnapshot(payload: Record<string, unknown>): GitStatusSnapshot | null {
  if (
    typeof payload.feature_id !== "number" ||
    typeof payload.current_branch !== "string" ||
    typeof payload.target_branch !== "string" ||
    typeof payload.uncommitted_count !== "number" ||
    typeof payload.staged_count !== "number" ||
    typeof payload.unstaged_count !== "number" ||
    typeof payload.untracked_count !== "number" ||
    typeof payload.ahead_of_remote !== "number" ||
    typeof payload.behind_remote !== "number" ||
    typeof payload.ahead_of_target !== "number" ||
    typeof payload.has_remote !== "boolean" ||
    typeof payload.computed_at !== "number"
  ) {
    return null;
  }
  return payload as unknown as GitStatusSnapshot;
}
