import { translateUi, type UiTranslator, useUiTranslation } from "@/lib/i18n/ui";
/**
 * Pure derivation: turn a `GitStatusSnapshot` into the smart-button state used
 * by `GitActionButton`. Kept pure (no React) so the snapshot matrix can be
 * tested directly with Vitest — `useGitAction` is a thin `useMemo` wrapper.
 *
 * Order of preference for the primary action: commit → update → push → pr → merge. Stash is
 * intentionally secondary-only, so adding tracked changes never replaces the
 * existing primary action. The first primary action that's enabled wins; if
 * none are, `primary` is `null` and the main button is disabled.
 */
import { useMemo } from "react";
import type { GitOperationKind, GitStatusSnapshot, PrSummary } from "@/api/generated";
import {
  compareActionLabel,
  primaryActionLabel,
  updateBlockedReason,
  viewProposalLabel,
} from "./gitActionLabels";
import { gitUpdateContinueDisabledReason } from "./gitUpdateMessages";

/** Used until the backend names the host's own action ("Open merge request"). */

export type GitAction = "commit" | "stash" | "update" | "push" | "pr" | "merge";
export type PrimaryGitAction = Exclude<GitAction, "stash">;
/**
 * Background state of a long-running Git action. `null` means nothing is
 * in flight, so the action behaves normally; otherwise the button and the
 * picker turn into a way back into the still-live output.
 */
export type GitActivity = "running" | "failed" | null;

/** Per-action background state. Only commit and push stream in background. */
export interface GitActivities {
  commit: GitActivity;
  push: GitActivity;
}

/** Actions that can be busy in the background, in primary-button priority order. */
export const ACTIVITY_ACTIONS = ["commit", "push"] as const;
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

export function isActivityAction(action: GitAction): action is ActivityAction {
  return (ACTIVITY_ACTIONS as readonly GitAction[]).includes(action);
}

/** Button copy while a run is in flight or has failed. */
export function gitActivityLabel(
  action: ActivityAction,
  activity: Exclude<GitActivity, null>,
  t: UiTranslator = translateUi,
): string {
  return action === "commit"
    ? activity === "running"
      ? t("workspace.git.useGitAction.committing", "Committing")
      : t("workspace.git.useGitAction.commitFailed", "Commit failed")
    : activity === "running"
      ? t("workspace.git.useGitAction.pushing", "Pushing")
      : t("workspace.git.useGitAction.pushFailed", "Push failed");
}

/**
 * Tooltip and picker-row copy: a backgrounded run turns its row into "show
 * me that output", which is the only way back into it.
 */
export function gitActivityHint(
  action: ActivityAction,
  activity: Exclude<GitActivity, null>,
  t: UiTranslator = translateUi,
): string {
  return action === "commit"
    ? activity === "running"
      ? t("workspace.git.useGitAction.commitProgress", "View commit progress")
      : t("workspace.git.useGitAction.commitError", "View commit error")
    : activity === "running"
      ? t("workspace.git.useGitAction.pushProgress", "View push progress")
      : t("workspace.git.useGitAction.pushError", "View push error");
}

/** The busiest action to surface on the primary button, if any. */
export function activeGitActivity(
  activities: GitActivities,
): { action: ActivityAction; activity: Exclude<GitActivity, null> } | null {
  for (const action of ACTIVITY_ACTIONS) {
    const activity = activities[action];
    if (activity) return { action, activity };
  }
  return null;
}

export interface GitUpdateRecoveryActionState {
  operation: GitOperationKind;
  conflictCount: number;
  continueDisabled: string | null;
  abortDisabled: string | null;
}

export interface GitActionState {
  primary: PrimaryGitAction | null;
  /** Human label for the primary action button (or the disabled placeholder). */
  label: string;
  /** Per-action reason. `null` = enabled, `string` = disabled-because reason. */
  disabled: Record<GitAction, string | null>;
  /** Compare-URL label (provider-aware, falls back to "Open pull request"). */
  compareLabel: string;
  /** Request state is local UI state; Git status still comes only from backend snapshots. */
  updatePending: boolean;
  /** Continue/Abort state for a backend-confirmed or just-returned recoverable update. */
  recovery: GitUpdateRecoveryActionState | null;
  statusUnavailable?: boolean;
}

interface GitActionOptions {
  updatePending?: boolean;
  stashMutationBlockedReason?: string | null;
  existingPr?: PrSummary;
  statusError?: string;
}

export interface GitUpdateSource {
  branch: string;
  ahead: number;
  behind: number;
  kind: "upstream" | "target";
  resolved: boolean;
}

const PRIMARY_ORDER: readonly PrimaryGitAction[] = ["commit", "update", "push", "pr", "merge"];

function disabledActions(reason: string): Record<GitAction, string> {
  return { commit: reason, stash: reason, update: reason, push: reason, pr: reason, merge: reason };
}

function loadingState(t: UiTranslator): GitActionState {
  const label = t("workspace.git.useGitAction.loading", "Loading…");
  return {
    primary: null,
    label,
    disabled: disabledActions(label),
    compareLabel: t("workspace.git.useGitAction.openPullRequest", "Open pull request"),
    updatePending: false,
    recovery: null,
  };
}

function deriveCommitDisabled(snapshot: GitStatusSnapshot, t: UiTranslator): string | null {
  return snapshot.uncommitted_count > 0
    ? null
    : t("workspace.git.useGitAction.noUncommittedChanges", "No uncommitted changes");
}

function deriveStashDisabled(snapshot: GitStatusSnapshot, t: UiTranslator): string | null {
  if ((snapshot.conflict_count ?? 0) > 0)
    return t(
      "workspace.git.useGitAction.resolveConflictingFilesFirst",
      "Resolve conflicting files first",
    );
  if (snapshot.uncommitted_count > 0) return null;
  return t("workspace.git.useGitAction.noChangesToStash", "No changes to stash");
}

function derivePushDisabled(snapshot: GitStatusSnapshot, t: UiTranslator): string | null {
  // Uncommitted changes never block push (or compare): `git push` only sends commits.
  return snapshot.ahead_of_remote > 0
    ? null
    : t("workspace.git.useGitAction.nothingToPush", "Nothing to push");
}

function derivePrDisabled(
  snapshot: GitStatusSnapshot,
  t: UiTranslator,
  existingPr?: PrSummary,
): string | null {
  if (existingPr) return null;
  if (snapshot.ahead_of_remote > 0)
    return t("workspace.git.useGitAction.pushYourCommitsFirst", "Push your commits first");
  if (!snapshot.has_remote)
    return t("workspace.git.useGitAction.noRemoteConfigured", "No remote configured");
  if (snapshot.ahead_of_target <= 0)
    return t("workspace.git.useGitAction.nothingToCompare", "Nothing to compare");
  // Provider-neutral: the backend ships `compare_url` only when it can
  // confidently build one (GitHub / GitLab / Bitbucket). For self-hosted or
  // unrecognized remotes (`host = Other`) the field is absent and we treat
  // the action as unavailable here. The frontend never branches on host
  // identity itself — that boundary lives in `host.rs`.
  if (snapshot.compare_url == null) {
    return t(
      "workspace.git.useGitAction.compareUrlNotAvailableForThisRemote",
      "Compare URL not available for this remote",
    );
  }
  return null;
}

function deriveMergeDisabled(snapshot: GitStatusSnapshot, t: UiTranslator): string | null {
  if (isSameLocalBranch(snapshot.current_branch, snapshot.target_branch)) {
    return t(
      "workspace.git.useGitAction.cannotMergeABranchIntoItself",
      "Cannot merge a branch into itself",
    );
  }
  if (snapshot.ahead_of_target <= 0)
    return t("workspace.git.useGitAction.nothingToMerge", "Nothing to merge");
  return null;
}

function deriveUpdateDisabled(snapshot: GitStatusSnapshot, t: UiTranslator): string | null {
  if (!isWorktreeClean(snapshot))
    return t(
      "workspace.git.useGitAction.commitOrStashYourChangesFirst",
      "Commit or stash your changes first",
    );
  const source = resolveGitUpdateSource(snapshot);
  if (!source.resolved) {
    return source.kind === "target"
      ? t("workspace.git.useGitAction.targetUnresolved", "Target '{{branch}}' does not resolve", {
          branch: source.branch,
        })
      : t(
          "workspace.git.useGitAction.updateSourceUnresolved",
          "Update source '{{branch}}' does not resolve",
          { branch: source.branch },
        );
  }
  if (isSameUpdateBranch(snapshot.current_branch, source.branch)) {
    return t(
      "workspace.git.useGitAction.currentBranchIsAlreadyTheUpdateTarget",
      "Current branch is already the update target",
    );
  }
  if (source.behind <= 0)
    return t("workspace.git.useGitAction.alreadyUpToDate", "Already up to date");
  return null;
}

export function resolveGitUpdateSource(snapshot: GitStatusSnapshot): GitUpdateSource {
  if (snapshot.update_target_branch) {
    return {
      branch: snapshot.update_target_branch,
      ahead: snapshot.ahead_of_update_target ?? 0,
      behind: snapshot.behind_update_target ?? 0,
      kind: snapshot.update_target_branch === snapshot.target_branch ? "target" : "upstream",
      resolved: snapshot.update_target_resolved === true,
    };
  }
  if (snapshot.behind_remote > 0) {
    return {
      branch: "@{upstream}",
      ahead: snapshot.ahead_of_remote,
      behind: snapshot.behind_remote,
      kind: "upstream",
      resolved: true,
    };
  }
  return {
    branch: snapshot.target_branch,
    ahead: snapshot.ahead_of_target,
    behind: snapshot.behind_target ?? 0,
    kind: "target",
    resolved: snapshot.target_resolved === true,
  };
}

function isSameUpdateBranch(currentBranch: string, targetBranch: string): boolean {
  const currentRef = currentBranch.startsWith("refs/heads/")
    ? currentBranch
    : `refs/heads/${currentBranch}`;
  const targetRef = targetBranch.startsWith("refs/heads/")
    ? targetBranch
    : `refs/heads/${targetBranch}`;
  return currentRef === targetRef;
}

function isWorktreeClean(snapshot: GitStatusSnapshot): boolean {
  return (
    snapshot.uncommitted_count === 0 &&
    snapshot.staged_count === 0 &&
    snapshot.unstaged_count === 0 &&
    snapshot.untracked_count === 0 &&
    (snapshot.conflict_count ?? 0) === 0
  );
}

function isSameLocalBranch(currentBranch: string, targetBranch: string): boolean {
  return currentBranch === localTargetBranchName(targetBranch);
}

function localTargetBranchName(targetBranch: string): string {
  return targetBranch.startsWith("origin/") ? targetBranch.slice("origin/".length) : targetBranch;
}

export function deriveGitAction(
  snapshot: GitStatusSnapshot | undefined,
  {
    updatePending = false,
    stashMutationBlockedReason,
    existingPr,
    statusError,
  }: GitActionOptions = {},
  t: UiTranslator = translateUi,
): GitActionState {
  const unavailable = statusError
    ? t("workspace.git.status.unavailable", "Git status unavailable")
    : null;
  if (!snapshot) {
    return unavailable
      ? {
          ...loadingState(t),
          label: unavailable,
          disabled: disabledActions(unavailable),
          statusUnavailable: true,
        }
      : loadingState(t);
  }

  const operation = snapshot.operation ?? null;
  const operationConflictCount = snapshot.conflict_count ?? 0;
  const mutationBlockedReason = unavailable ?? updateBlockedReason(updatePending, operation, t);

  // A project directory can be open before it has a Git checkout.
  if (!snapshot.current_branch) {
    const reason =
      unavailable ??
      t("workspace.git.useGitAction.noWorktreeAvailableYet", "No worktree available yet");
    return {
      primary: null,
      label: reason,
      disabled: disabledActions(reason),
      compareLabel: compareActionLabel(snapshot.action_label, t),
      updatePending,
      recovery: null,
      statusUnavailable: !!unavailable,
    };
  }

  const compareLabel = existingPr
    ? viewProposalLabel(existingPr, t)
    : compareActionLabel(snapshot.action_label, t);
  const disabled: Record<GitAction, string | null> = {
    commit: mutationBlockedReason ?? deriveCommitDisabled(snapshot, t),
    stash: mutationBlockedReason ?? stashMutationBlockedReason ?? deriveStashDisabled(snapshot, t),
    update: mutationBlockedReason ?? deriveUpdateDisabled(snapshot, t),
    push: mutationBlockedReason ?? derivePushDisabled(snapshot, t),
    // Opening an existing compare URL does not mutate Git, so keep it
    // available while an update request or recovery operation is active.
    pr: existingPr ? null : (unavailable ?? derivePrDisabled(snapshot, t)),
    merge: mutationBlockedReason ?? deriveMergeDisabled(snapshot, t),
  };

  const primary = mutationBlockedReason
    ? null
    : (PRIMARY_ORDER.find((action) => disabled[action] === null) ?? null);
  const label =
    unavailable ?? primaryActionLabel(primary, updatePending, compareLabel, disabled.commit, t);

  const recovery = operation
    ? {
        operation,
        conflictCount: operationConflictCount,
        continueDisabled: updatePending
          ? t("workspace.git.useGitAction.updateRequestInProgress", "Update request in progress")
          : gitUpdateContinueDisabledReason(operationConflictCount, t),
        abortDisabled: updatePending
          ? t("workspace.git.useGitAction.updateRequestInProgress", "Update request in progress")
          : null,
      }
    : null;

  return {
    primary,
    label,
    disabled,
    compareLabel,
    updatePending,
    recovery,
    statusUnavailable: !!unavailable,
  };
}

/** Keep the derived controls stable until their inputs change. */
export function useGitAction(
  snapshot: GitStatusSnapshot | undefined,
  { updatePending, stashMutationBlockedReason, existingPr, statusError }: GitActionOptions,
): GitActionState {
  const { t } = useUiTranslation();
  return useMemo(
    () =>
      deriveGitAction(
        snapshot,
        {
          updatePending,
          stashMutationBlockedReason,
          existingPr,
          statusError,
        },
        t,
      ),
    [existingPr, snapshot, stashMutationBlockedReason, statusError, t, updatePending],
  );
}
