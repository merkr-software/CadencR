/**
 * Pure derivation: turn a `GitStatusSnapshot` into the smart-button state used
 * by `GitActionButton`. Kept pure (no React) so the snapshot matrix can be
 * tested directly with Vitest — `useGitAction` is a thin `useMemo` wrapper.
 *
 * Order of preference for the primary action: commit → push → pr. The first
 * one that's enabled wins; if none are, `primary` is `null` and the main
 * button is disabled with the most relevant reason.
 */
import { useMemo } from "react";
import type { GitStatusSnapshot } from "@/api/generated";

export type GitAction = "commit" | "push" | "pr" | "merge";
export type CommitActivity = "running" | "failed" | null;

export interface GitActionState {
  primary: GitAction | null;
  /** Human label for the primary action button (or the disabled placeholder). */
  label: string;
  /** Per-action reason. `null` = enabled, `string` = disabled-because reason. */
  disabled: Record<GitAction, string | null>;
  /** Compare-URL label (provider-aware, falls back to "Open PR"). */
  compareLabel: string;
}

const ORDER: readonly GitAction[] = ["commit", "push", "pr", "merge"] as const;

const LOADING_STATE: GitActionState = {
  primary: null,
  label: "Loading…",
  disabled: { commit: "Loading…", push: "Loading…", pr: "Loading…", merge: "Loading…" },
  compareLabel: "Open PR",
};

function deriveCommitDisabled(snapshot: GitStatusSnapshot): string | null {
  return snapshot.uncommitted_count > 0 ? null : "No uncommitted changes";
}

function derivePushDisabled(snapshot: GitStatusSnapshot): string | null {
  if (snapshot.uncommitted_count > 0) return "Commit your changes first";
  if (snapshot.ahead_of_remote <= 0) return "Nothing to push";
  return null;
}

function derivePrDisabled(snapshot: GitStatusSnapshot): string | null {
  if (snapshot.uncommitted_count > 0) return "Commit your changes first";
  if (snapshot.ahead_of_remote > 0) return "Push your commits first";
  if (!snapshot.has_remote) return "No remote configured";
  if (snapshot.ahead_of_target <= 0) return "Nothing to compare";
  // Provider-neutral: the backend ships `compare_url` only when it can
  // confidently build one (GitHub / GitLab / Bitbucket). For self-hosted or
  // unrecognized remotes (`host = Other`) the field is absent and we treat
  // the action as unavailable here. The frontend never branches on host
  // identity itself — that boundary lives in `host.rs`.
  if (snapshot.compare_url == null) {
    return "Compare URL not available for this remote";
  }
  return null;
}

function deriveMergeDisabled(snapshot: GitStatusSnapshot): string | null {
  if (isSameLocalBranch(snapshot.current_branch, snapshot.target_branch)) {
    return "Cannot merge a branch into itself";
  }
  if (snapshot.ahead_of_target <= 0) return "Nothing to merge";
  return null;
}

function isSameLocalBranch(currentBranch: string, targetBranch: string): boolean {
  return currentBranch === localTargetBranchName(targetBranch);
}

function localTargetBranchName(targetBranch: string): string {
  return targetBranch.startsWith("origin/") ? targetBranch.slice("origin/".length) : targetBranch;
}

export function deriveGitAction(snapshot: GitStatusSnapshot | undefined): GitActionState {
  if (!snapshot) return LOADING_STATE;

  // Degraded snapshot from the backend: `current_branch` is empty when the
  // worktree path doesn't resolve on disk (still being created, or stale
  // setting). Surface that explicitly so the button doesn't show a misleading
  // "No uncommitted changes" reason.
  if (!snapshot.current_branch) {
    const reason = "No worktree available yet";
    return {
      primary: null,
      label: reason,
      disabled: { commit: reason, push: reason, pr: reason, merge: reason },
      compareLabel: snapshot.action_label ?? "Open PR",
    };
  }

  const compareLabel = snapshot.action_label ?? "Open PR";
  const disabled: Record<GitAction, string | null> = {
    commit: deriveCommitDisabled(snapshot),
    push: derivePushDisabled(snapshot),
    pr: derivePrDisabled(snapshot),
    merge: deriveMergeDisabled(snapshot),
  };

  const primary = ORDER.find((action) => disabled[action] === null) ?? null;
  const label =
    primary === "commit"
      ? "Commit"
      : primary === "push"
        ? "Push"
        : primary === "pr"
          ? compareLabel
          : primary === "merge"
            ? "Merge"
            : (disabled.commit ?? "No action");

  return { primary, label, disabled, compareLabel };
}

/**
 * Memoized wrapper around `deriveGitAction`. Re-runs only when the snapshot
 * reference changes (the store keeps snapshots stable until the backend pushes
 * a new one for the same feature).
 */
export function useGitAction(snapshot: GitStatusSnapshot | undefined): GitActionState {
  return useMemo(() => deriveGitAction(snapshot), [snapshot]);
}
