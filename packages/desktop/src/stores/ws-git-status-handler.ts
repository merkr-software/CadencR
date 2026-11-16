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
import { scopedToastDescription } from "@/components/ToastScope";
import {
  CiState,
  PrState,
  ReviewState,
  type CiRollup,
  type ForgeUser,
  type GitStatusSnapshot,
  type PrStatusSnapshot,
  type PrSummary,
} from "@/api/generated";
import { queryClient } from "@/lib/queryClient";
import { gitStatusSnapshotsEqual, useGitStatusStore } from "@/stores/useGitStatusStore";
import { useCommitOutputStore } from "@/stores/useCommitOutputStore";
import { usePushOutputStore } from "@/stores/usePushOutputStore";
import { usePrStatusStore } from "@/stores/usePrStatusStore";

/** URL prefixes for every cached query that may need refreshing when a
 *  worktree's git state changes. Orval keys all start with the URL string.
 *
 *  `/api/git/status` is intentionally absent: the WS push has already updated
 *  `useGitStatusStore` (the source of truth for live status), and re-fetching
 *  the HTTP one-shot would race the WS push and cause the branch chip to
 *  flicker — the HTTP response computed at T can land after a WS push
 *  computed at T+Δ. The HTTP query is only used for first-paint hydration. */
const GIT_CONTENT_INVALIDATION_PREFIXES = [
  "/api/git/changed-files",
  "/api/git/diff",
  "/api/git/file-diff",
  "/api/git/file-blob-shas",
  "/api/git/stats",
  "/api/git/stashes",
  "/api/git/uncommitted-files",
  "/api/git/has-uncommitted-changes",
] as const;

/** History queries: what a commit, push, fetch or reset changes. The graph
 *  paints each commit's pushed state and the remote-tracking refs, so a push —
 *  which moves `origin/<branch>` and `ahead_of_remote` but not one file — must
 *  refetch it too. It re-runs `git log --shortstat` over every loaded page, so
 *  it is refetched only when a history-bearing field moves, never for the
 *  working-tree churn of an agent writing files. */
const GIT_HISTORY_INVALIDATION_PREFIXES = ["/api/git/commit-log", "/api/git/commit-graph"] as const;

const GIT_STATUS_INVALIDATION_PREFIXES = [
  ...GIT_CONTENT_INVALIDATION_PREFIXES,
  ...GIT_HISTORY_INVALIDATION_PREFIXES,
] as const;

/** Fields a commit, amend, reset, push, pull or checkout moves. `staged_count`
 *  is here because a commit consumes the index: an amend that leaves every
 *  ahead/behind count equal still empties it. */
function historyMoved(a: GitStatusSnapshot, b: GitStatusSnapshot): boolean {
  return (
    a.current_branch !== b.current_branch ||
    a.staged_count !== b.staged_count ||
    a.ahead_of_remote !== b.ahead_of_remote ||
    a.behind_remote !== b.behind_remote ||
    a.ahead_of_target !== b.ahead_of_target ||
    a.behind_target !== b.behind_target ||
    a.operation !== b.operation
  );
}

export function handleGitEnvelope(action: string, payload: Record<string, unknown>): void {
  if (action === "pr_status") {
    handlePrStatusEnvelope(payload);
    return;
  }
  if (action === "status") {
    const snapshot = parseGitStatusSnapshot(payload);
    if (!snapshot) return;
    const existing = useGitStatusStore.getState().byFeature[snapshot.feature_id];
    const prefixes = getGitInvalidationPrefixes(existing, snapshot);
    // Live status (branch chip, counts) updates immediately — it's cheap.
    useGitStatusStore.getState().setStatus(snapshot);
    // The heavy git *content* queries (diff, changed-files, …) are coalesced:
    // during a terminal rebase/merge the watcher pushes a snapshot per second
    // for the whole operation, and refetching + re-rendering an unbounded diff
    // on every push freezes the UI. See `scheduleGitInvalidation`.
    if (prefixes.length > 0) scheduleGitInvalidation(snapshot.feature_id, prefixes);
    return;
  }
  if (action === "status_error") {
    const featureId = typeof payload.feature_id === "number" ? payload.feature_id : null;
    const error = typeof payload.error === "string" ? payload.error : null;
    if (featureId == null || !error) return;
    useGitStatusStore.getState().setStatusError({ feature_id: featureId, error });
    // Pushed for any watched worktree, not just the one on screen, and again
    // on every watcher tick while it fails: one toast per feature.
    toast.error("Git status error", {
      id: `git-status-error-${featureId}`,
      description: scopedToastDescription({ featureId }, error),
    });
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
    const success = typeof payload.success === "boolean" ? payload.success : null;
    if (featureId == null || success == null) return;
    useCommitOutputStore.getState().complete(featureId, success);
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
    const success = typeof payload.success === "boolean" ? payload.success : null;
    if (featureId == null || success == null) return;
    usePushOutputStore.getState().complete(featureId, success);
    // The backend broadcasts the post-push status first, so a push that moved
    // `ahead_of_remote` is already refetching history; join that fetch rather
    // than restarting it. This call matters when the counts stay put — a first
    // `-u` push, a force-push — and only the remote-tracking ref moved.
    if (success) {
      void invalidateGitQueriesForFeature(featureId, GIT_HISTORY_INVALIDATION_PREFIXES, {
        cancelRefetch: false,
      });
    }
  }
}

function handlePrStatusEnvelope(payload: Record<string, unknown>): void {
  const snapshot = parsePrStatusSnapshot(payload);
  if (!snapshot) {
    toast.error("Invalid pull request status update received.");
    return;
  }
  const existing = usePrStatusStore.getState().byFeature[snapshot.feature_id];
  usePrStatusStore.getState().setStatus(snapshot);
  if (!shouldInvalidatePrComments(existing, snapshot)) return;
  void queryClient.invalidateQueries({
    predicate: (query) => {
      const head = query.queryKey[0];
      return (
        typeof head === "string" &&
        head.startsWith("/api/git/pr/comments") &&
        queryParamsMatchFeature(query.queryKey[1], snapshot.feature_id)
      );
    },
    refetchType: "active",
  });
}

function getGitInvalidationPrefixes(
  existing: GitStatusSnapshot | undefined,
  snapshot: GitStatusSnapshot,
): readonly string[] {
  if (!existing) return [];
  if (existing.computed_at > snapshot.computed_at) return [];
  if (!gitStatusSnapshotsEqual(existing, snapshot)) {
    return historyMoved(existing, snapshot)
      ? GIT_STATUS_INVALIDATION_PREFIXES
      : GIT_CONTENT_INVALIDATION_PREFIXES;
  }
  if (snapshot.computed_at > existing.computed_at) return GIT_CONTENT_INVALIDATION_PREFIXES;
  return [];
}

/**
 * Settle window for coalescing git content-query invalidations.
 *
 * Must exceed the backend watcher's `MIN_RECOMPUTE_GAP_MS` (1000 ms, see
 * `packages/service/src/domain/git/watcher/debouncer.rs`) so that consecutive
 * snapshots emitted during sustained churn (a rebase, a large agent write)
 * land inside the same window and collapse into a single trailing refetch
 * instead of one per snapshot.
 */
const GIT_INVALIDATION_SETTLE_MS = 1_200;

interface PendingGitInvalidation {
  /** Union of invalidation prefixes accumulated while the window is open. */
  prefixes: Set<string>;
  timer: ReturnType<typeof setTimeout>;
}

const pendingGitInvalidations = new Map<number, PendingGitInvalidation>();

/**
 * Coalesce git content-query invalidations per feature so a churn storm (a
 * terminal rebase/merge, a bulk agent write) can't trigger a full diff
 * refetch + synchronous re-render on every `git.status` push.
 *
 * Leading edge: the first change after a quiet period invalidates immediately,
 * so a lone edit shows up in the diff without delay. Subsequent changes while
 * the window is open only accumulate prefixes and push the settle out — so a
 * sustained rebase produces one refetch at the start and one once it settles,
 * never one per second for the whole operation.
 */
function scheduleGitInvalidation(featureId: number, prefixes: readonly string[]): void {
  const existing = pendingGitInvalidations.get(featureId);
  if (!existing) {
    // Leading edge — refetch now and open the settle window.
    void invalidateGitQueriesForFeature(featureId, prefixes);
    pendingGitInvalidations.set(featureId, {
      prefixes: new Set(),
      timer: setTimeout(() => flushPendingGitInvalidation(featureId), GIT_INVALIDATION_SETTLE_MS),
    });
    return;
  }
  // Inside the window — accumulate and debounce the trailing refetch.
  for (const p of prefixes) existing.prefixes.add(p);
  clearTimeout(existing.timer);
  existing.timer = setTimeout(
    () => flushPendingGitInvalidation(featureId),
    GIT_INVALIDATION_SETTLE_MS,
  );
}

function flushPendingGitInvalidation(featureId: number): void {
  const entry = pendingGitInvalidations.get(featureId);
  if (!entry) return;
  if (entry.prefixes.size === 0) {
    // Quiet — close the window.
    pendingGitInvalidations.delete(featureId);
    return;
  }
  // Trailing refetch: captures the settled state after a burst.
  const prefixes = [...entry.prefixes];
  entry.prefixes = new Set();
  void invalidateGitQueriesForFeature(featureId, prefixes);
  // Re-arm so a still-ongoing storm keeps coalescing; the next fire with no
  // accumulated prefixes closes the window.
  entry.timer = setTimeout(
    () => flushPendingGitInvalidation(featureId),
    GIT_INVALIDATION_SETTLE_MS,
  );
}

/** Test-only: cancel pending timers and drop coalescing state between cases. */
export function resetGitInvalidationSchedulingForTest(): void {
  for (const entry of pendingGitInvalidations.values()) clearTimeout(entry.timer);
  pendingGitInvalidations.clear();
}

function invalidateGitQueriesForFeature(
  featureId: number,
  prefixes: readonly string[],
  options?: { cancelRefetch: boolean },
): Promise<void> {
  return queryClient.invalidateQueries(
    {
      predicate: (query) => {
        const head = query.queryKey[0];
        if (typeof head !== "string") return false;
        if (!prefixes.some((prefix) => head.startsWith(prefix))) return false;
        return queryParamsMatchFeature(query.queryKey[1], featureId);
      },
    },
    options,
  );
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

export function parsePrStatusSnapshot(payload: Record<string, unknown>): PrStatusSnapshot | null {
  if (
    typeof payload.feature_id !== "number" ||
    typeof payload.fetched_at !== "number" ||
    typeof payload.setup_required !== "boolean"
  ) {
    return null;
  }
  if (payload.error != null && typeof payload.error !== "string") return null;
  if (payload.pr != null && !isPrSummary(payload.pr)) return null;
  if (payload.ci != null && !isCiRollup(payload.ci)) return null;
  return payload as unknown as PrStatusSnapshot;
}

function shouldInvalidatePrComments(
  existing: PrStatusSnapshot | undefined,
  incoming: PrStatusSnapshot,
): boolean {
  if (!existing?.pr || !incoming.pr) return false;
  return (
    existing.pr.number !== incoming.pr.number || existing.pr.updated_at !== incoming.pr.updated_at
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isForgeUser(value: unknown): value is ForgeUser {
  if (!isRecord(value) || typeof value.username !== "string") return false;
  if (value.display_name != null && typeof value.display_name !== "string") return false;
  return value.avatar_url == null || typeof value.avatar_url === "string";
}

function isPrSummary(value: unknown): value is PrSummary {
  if (!isRecord(value)) return false;
  return (
    typeof value.number === "number" &&
    typeof value.title === "string" &&
    typeof value.body_markdown === "string" &&
    Object.values(PrState).includes(value.state as never) &&
    typeof value.url === "string" &&
    typeof value.source_branch === "string" &&
    typeof value.target_branch === "string" &&
    typeof value.head_sha === "string" &&
    Object.values(ReviewState).includes(value.review_state as never) &&
    isForgeUser(value.author) &&
    typeof value.updated_at === "string" &&
    typeof value.pr_label === "string"
  );
}

function isCiRollup(value: unknown): value is CiRollup {
  if (!isRecord(value) || !Object.values(CiState).includes(value.state as never)) return false;
  if (!Array.isArray(value.checks)) return false;
  return value.checks.every(
    (check) =>
      isRecord(check) &&
      typeof check.name === "string" &&
      Object.values(CiState).includes(check.state as never) &&
      (check.url == null || typeof check.url === "string"),
  );
}
