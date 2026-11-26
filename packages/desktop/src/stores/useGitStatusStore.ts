/**
 * Per-feature git status store.
 *
 * Mirrors the `GitStatusSnapshot` envelopes the backend pushes on
 * `domain="git" action="status"` and `action="status_error"`. The store is the
 * single source of truth for live Git counts. HTTP supplies the initial result
 * until the active subscription has reported a status or calculation error.
 *
 * Consumers must read via the exported selectors (per
 * `frontend-performance.md` — never call the store hook without a selector).
 */
import { create } from "zustand";
import type { GitStatusSnapshot } from "@/api/generated";
import { WORKTREE_UNAVAILABLE } from "@/lib/api-errors";

export interface GitStatusHealth {
  statusError?: string;
  statusErrorCode?: string;
  watcherError?: string;
}

interface GitStatusState {
  byFeature: Record<number, GitStatusSnapshot>;
  healthByFeature: Record<number, GitStatusHealth>;
  subscriptionByFeature: Record<number, "pending" | "answered">;
  hydrationEpoch: Record<number, number>;
  /**
   * Per-feature counter the WS envelope handler bumps on every
   * `workflow/worktree.created` / `workflow/worktree.ready` event. The
   * `useGitStatusSubscription` hook reads this counter as a dep so it can
   * tear down the old WS subscription and re-subscribe — that forces the
   * backend to re-resolve `worktree_path` and bind its `notify` watcher to
   * the freshly-created worktree path. Otherwise the watcher stays bound to
   * whatever path was resolvable at first subscribe (typically the project
   * path while the worktree was still being created), and the chip never
   * leaves the base branch.
   */
  watcherEpoch: Record<number, number>;
  hydrateStatus: (featureId: number, result: GitStatusSnapshot | string, code?: string) => void;
  setStatus: (snapshot: GitStatusSnapshot, watcherError?: string | null) => void;
  setStatusError: (
    params: { feature_id: number; error: string; code?: string },
    watcherError?: string | null,
  ) => void;
  setSubscription: (featureId: number, subscription?: "pending" | "answered") => void;
  bumpWatcherEpoch: (featureId: number) => void;
  discardSnapshot: (featureId: number) => void;
  clearStatus: (featureId: number) => void;
}

export const useGitStatusStore = create<GitStatusState>((set) => ({
  byFeature: {},
  healthByFeature: {},
  subscriptionByFeature: {},
  hydrationEpoch: {},
  watcherEpoch: {},

  hydrateStatus(featureId, result, code) {
    set((state) => {
      if (state.subscriptionByFeature[featureId] === "answered") return state;
      const watcherError = state.healthByFeature[featureId]?.watcherError;
      if (typeof result === "string") {
        return applyStatusFailure(state, featureId, {
          statusError: result,
          statusErrorCode: code,
          watcherError,
        });
      }
      if (result.feature_id !== featureId) return state;
      return updateSnapshot(state, result, { watcherError });
    });
  },

  setStatus(snapshot, watcherError) {
    set((state) => {
      const featureId = snapshot.feature_id;
      const health = liveHealth(state, featureId, watcherError);
      const current = state.byFeature[featureId];
      if (current && current.computed_at > snapshot.computed_at && watcherError !== undefined) {
        // An old scan can still acknowledge the current subscription's watch.
        return updateHealth(state, featureId, {
          ...health,
          statusError: state.healthByFeature[featureId]?.statusError,
          statusErrorCode: state.healthByFeature[featureId]?.statusErrorCode,
        });
      }
      return updateSnapshot(state, snapshot, health);
    });
  },

  setStatusError({ feature_id, error, code }, watcherError) {
    set((state) =>
      applyStatusFailure(state, feature_id, {
        ...liveHealth(state, feature_id, watcherError),
        statusError: error,
        statusErrorCode: code,
      }),
    );
  },

  setSubscription(featureId, subscription) {
    set((state) => {
      if (subscription === "pending") {
        return {
          byFeature: withoutKey(state.byFeature, featureId),
          subscriptionByFeature: { ...state.subscriptionByFeature, [featureId]: subscription },
        };
      }
      if (state.subscriptionByFeature[featureId] === subscription) return state;
      if (subscription) {
        return {
          hydrationEpoch: nextHydrationEpoch(state, featureId),
          subscriptionByFeature: { ...state.subscriptionByFeature, [featureId]: subscription },
        };
      }
      const { [featureId]: _ended, ...remaining } = state.subscriptionByFeature;
      return { subscriptionByFeature: remaining };
    });
  },

  discardSnapshot(featureId) {
    set((state) => resetHydration(state, featureId));
  },

  bumpWatcherEpoch(featureId) {
    set((state) => ({
      watcherEpoch: {
        ...state.watcherEpoch,
        [featureId]: (state.watcherEpoch[featureId] ?? 0) + 1,
      },
    }));
  },

  clearStatus(featureId) {
    set((state) => {
      const { [featureId]: _droppedSnap, ...remainingSnap } = state.byFeature;
      const { [featureId]: _droppedHealth, ...remainingHealth } = state.healthByFeature;
      return { byFeature: remainingSnap, healthByFeature: remainingHealth };
    });
  },
}));

function withoutKey<T>(entries: Record<number, T>, featureId: number): Record<number, T> {
  const { [featureId]: _removed, ...remaining } = entries;
  return remaining;
}

function resetHydration(state: GitStatusState, featureId: number) {
  return {
    byFeature: state.byFeature[featureId]
      ? withoutKey(state.byFeature, featureId)
      : state.byFeature,
    hydrationEpoch: nextHydrationEpoch(state, featureId),
  };
}

function nextHydrationEpoch(state: GitStatusState, featureId: number) {
  return { ...state.hydrationEpoch, [featureId]: (state.hydrationEpoch[featureId] ?? 0) + 1 };
}

function applyStatusFailure(
  state: GitStatusState,
  featureId: number,
  health: GitStatusHealth,
): GitStatusState {
  const next = updateHealth(state, featureId, health);
  return health.statusErrorCode === WORKTREE_UNAVAILABLE && next.byFeature[featureId]
    ? { ...next, byFeature: withoutKey(next.byFeature, featureId) }
    : next;
}

function liveHealth(
  state: GitStatusState,
  featureId: number,
  watcherError: string | null | undefined,
): GitStatusHealth {
  return {
    watcherError:
      watcherError === undefined
        ? state.healthByFeature[featureId]?.watcherError
        : (watcherError ?? undefined),
  };
}

function updateHealth(
  state: GitStatusState,
  featureId: number,
  next: GitStatusHealth,
): GitStatusState {
  const previous = state.healthByFeature[featureId];
  if (
    previous?.statusError === next.statusError &&
    previous?.statusErrorCode === next.statusErrorCode &&
    previous?.watcherError === next.watcherError
  ) {
    return state;
  }
  if (!next.statusError && !next.watcherError) {
    const { [featureId]: _recovered, ...remaining } = state.healthByFeature;
    return { ...state, healthByFeature: remaining };
  }
  return { ...state, healthByFeature: { ...state.healthByFeature, [featureId]: next } };
}

function updateSnapshot(
  state: GitStatusState,
  snapshot: GitStatusSnapshot,
  health: GitStatusHealth,
): GitStatusState {
  const featureId = snapshot.feature_id;
  const previous = state.byFeature[featureId];
  if (previous && previous.computed_at > snapshot.computed_at) return state;
  const next = updateHealth(state, featureId, health);
  if (
    previous?.computed_at === snapshot.computed_at &&
    gitStatusSnapshotsEqual(previous, snapshot)
  ) {
    return next;
  }
  return { ...next, byFeature: { ...next.byFeature, [featureId]: snapshot } };
}

export function gitStatusSnapshotsEqual(a: GitStatusSnapshot, b: GitStatusSnapshot): boolean {
  return (
    a.feature_id === b.feature_id &&
    a.current_branch === b.current_branch &&
    a.target_branch === b.target_branch &&
    a.uncommitted_count === b.uncommitted_count &&
    a.staged_count === b.staged_count &&
    a.unstaged_count === b.unstaged_count &&
    a.untracked_count === b.untracked_count &&
    a.ahead_of_remote === b.ahead_of_remote &&
    a.behind_remote === b.behind_remote &&
    a.ahead_of_target === b.ahead_of_target &&
    a.behind_target === b.behind_target &&
    a.target_resolved === b.target_resolved &&
    a.update_target_branch === b.update_target_branch &&
    a.ahead_of_update_target === b.ahead_of_update_target &&
    a.behind_update_target === b.behind_update_target &&
    a.update_target_resolved === b.update_target_resolved &&
    a.conflict_count === b.conflict_count &&
    a.operation === b.operation &&
    a.has_remote === b.has_remote &&
    a.host === b.host &&
    a.compare_url === b.compare_url &&
    a.action_label === b.action_label &&
    sharedFeaturesEqual(a.shared_with, b.shared_with)
  );
}

function sharedFeaturesEqual(
  a: GitStatusSnapshot["shared_with"],
  b: GitStatusSnapshot["shared_with"],
): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index];
    return other != null && entry.feature_id === other.feature_id && entry.title === other.title;
  });
}

/** Narrow selector: snapshot for one feature. Stable reference until the
 *  backend pushes a new snapshot for this feature. */
export function selectGitStatus(
  featureId: number | null | undefined,
): (state: GitStatusState) => GitStatusSnapshot | undefined {
  return (state) => (featureId == null ? undefined : state.byFeature[featureId]);
}

/** Narrow selector for the one status field that drives Git diff query params.
 *  A fresh watcher snapshot gets a new `computed_at` on every file change; Git
 *  panel consumers that only need the target branch must not re-render for it. */
export function selectGitTargetBranch(
  featureId: number | null | undefined,
): (state: GitStatusState) => string | undefined {
  return (state) => (featureId == null ? undefined : state.byFeature[featureId]?.target_branch);
}

/** The target branch when the snapshot reports it resolves to no commit — an
 *  implicit `main` in a repository without one — else `undefined`. The service
 *  omits `target_resolved` when it is false, so only `true` means resolved. */
export function selectGitMissingTargetBranch(
  featureId: number | null | undefined,
): (state: GitStatusState) => string | undefined {
  return (state) => {
    const snapshot = featureId == null ? undefined : state.byFeature[featureId];
    return snapshot?.current_branch && snapshot.target_resolved !== true
      ? snapshot.target_branch
      : undefined;
  };
}

/**
 * Narrow selectors for the two counts the Git sub-tab strip badges. Both return
 * a number, so a watcher snapshot that only moved `computed_at` re-renders
 * nothing — which is the whole reason these exist rather than `selectGitStatus`.
 */
export function selectGitUncommittedCount(
  featureId: number | null | undefined,
): (state: GitStatusState) => number | undefined {
  return (state) => (featureId == null ? undefined : state.byFeature[featureId]?.uncommitted_count);
}

export function selectGitConflictCount(
  featureId: number | null | undefined,
): (state: GitStatusState) => number {
  return (state) => (featureId == null ? 0 : (state.byFeature[featureId]?.conflict_count ?? 0));
}

/** Narrow selector for the checked-out branch shown in branch-aware Git views. */
export function selectGitCurrentBranch(
  featureId: number | null | undefined,
): (state: GitStatusState) => string | undefined {
  return (state) => (featureId == null ? undefined : state.byFeature[featureId]?.current_branch);
}

/** Narrow selectors for the branch's standing against its remote; `undefined`
 *  before the first snapshot. (`has_remote` is not consulted: it means "a
 *  forge host was recognized", and a push works without one.) */
export function selectGitAheadOfRemote(
  featureId: number | null | undefined,
): (state: GitStatusState) => number | undefined {
  return (state) => (featureId == null ? undefined : state.byFeature[featureId]?.ahead_of_remote);
}

export function selectGitBehindRemote(
  featureId: number | null | undefined,
): (state: GitStatusState) => number | undefined {
  return (state) => (featureId == null ? undefined : state.byFeature[featureId]?.behind_remote);
}

/** Only subscription replies can clear a watcher setup failure. */
export function selectGitStatusHealth(
  featureId: number | null | undefined,
): (state: GitStatusState) => GitStatusHealth | undefined {
  return (state) => (featureId == null ? undefined : state.healthByFeature[featureId]);
}

export function selectGitWorktreeError(
  featureId: number,
): (state: GitStatusState) => string | undefined {
  return (state) => {
    const health = state.healthByFeature[featureId];
    return health?.statusErrorCode === WORKTREE_UNAVAILABLE ? health.statusError : undefined;
  };
}

export function selectGitCheckoutPending(featureId: number): (state: GitStatusState) => boolean {
  return (state) =>
    !state.byFeature[featureId] &&
    !state.healthByFeature[featureId]?.statusError &&
    (state.subscriptionByFeature[featureId] === "pending" ||
      state.hydrationEpoch[featureId] != null);
}

/** Narrow selector: WS-watcher epoch counter for one feature. Bumped by the
 *  envelope handler on `worktree.created`/`worktree.ready` so the
 *  subscription hook can re-issue subscribe and force the backend to
 *  re-resolve `worktree_path`. */
export function selectGitWatcherEpoch(
  featureId: number | null | undefined,
): (state: GitStatusState) => number {
  return (state) => (featureId == null ? 0 : (state.watcherEpoch[featureId] ?? 0));
}
