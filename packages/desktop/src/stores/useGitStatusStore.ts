/**
 * Per-feature git status store.
 *
 * Mirrors the `GitStatusSnapshot` envelopes the backend pushes on
 * `domain="git" action="status"` and `action="status_error"`. The store is the
 * single source of truth for live git counts; per `no-optimistic-updates.md`
 * we never mutate it from action handlers — only the WS dispatcher writes here.
 *
 * Consumers must read via the exported selectors (per
 * `frontend-performance.md` — never call the store hook without a selector).
 */
import { create } from "zustand";
import type { GitStatusSnapshot } from "@/api/generated";

interface GitStatusState {
  byFeature: Record<number, GitStatusSnapshot>;
  errorByFeature: Record<number, string>;
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
  setStatus: (snapshot: GitStatusSnapshot) => void;
  setStatusError: (params: { feature_id: number; error: string }) => void;
  bumpWatcherEpoch: (featureId: number) => void;
  clearStatus: (featureId: number) => void;
}

export const useGitStatusStore = create<GitStatusState>((set) => ({
  byFeature: {},
  errorByFeature: {},
  watcherEpoch: {},

  setStatus(snapshot) {
    set((state) => {
      // Two writers feed this store: the WS push (live, from the backend's
      // notify watcher) and the one-shot HTTP `useGetGitStatus` query (used
      // for first-paint hydration). They can race during worktree setup —
      // the HTTP response computed at T can land after a WS push computed at
      // T+Δ and clobber the fresher value, causing the branch chip to flicker
      // between the base branch and the new feature branch.
      //
      // Guard with `computed_at` (unix millis): drop the incoming snapshot
      // when we already hold a strictly newer one. Equal timestamps still
      // overwrite — that lets a re-send with the same `computed_at` (e.g. an
      // explicit recompute after a write) refresh derived fields like
      // `shared_with` without being treated as stale.
      const existing = state.byFeature[snapshot.feature_id];
      if (existing && existing.computed_at > snapshot.computed_at) {
        return state;
      }
      // Drop the stored error for this feature on a successful update so the
      // UI doesn't keep showing a stale toast/inline message.
      const { [snapshot.feature_id]: _droppedErr, ...remainingErrors } = state.errorByFeature;
      if (existing && gitStatusSnapshotsEqual(existing, snapshot)) {
        const hasError = state.errorByFeature[snapshot.feature_id] !== undefined;
        if (!hasError && existing.computed_at === snapshot.computed_at) return state;
        return {
          byFeature: { ...state.byFeature, [snapshot.feature_id]: snapshot },
          errorByFeature: remainingErrors,
        };
      }
      return {
        byFeature: { ...state.byFeature, [snapshot.feature_id]: snapshot },
        errorByFeature: remainingErrors,
      };
    });
  },

  setStatusError({ feature_id, error }) {
    set((state) => ({
      errorByFeature: { ...state.errorByFeature, [feature_id]: error },
    }));
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
      const { [featureId]: _droppedErr, ...remainingErr } = state.errorByFeature;
      return { byFeature: remainingSnap, errorByFeature: remainingErr };
    });
  },
}));

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

/** Narrow selector: latest error for one feature (cleared on next success). */
export function selectGitStatusError(
  featureId: number | null | undefined,
): (state: GitStatusState) => string | undefined {
  return (state) => (featureId == null ? undefined : state.errorByFeature[featureId]);
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
