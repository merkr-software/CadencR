import { translateUi, type UiTranslator } from "@/lib/i18n/ui";
/**
 * Words for the PR pane's approval and merge controls.
 *
 * Everything here reads the provider-neutral merge status. A merge queue and a
 * merge train are the same idea under two names, so the noun comes from the
 * status's `queue` kind rather than from which forge answered.
 */
import type {
  MergeAction,
  MergeMethod,
  MergeOutcome,
  MergeReadiness,
  PrApprovals,
  PrMergeStatus,
} from "@/api/generated";
import type { PrIndicatorTone } from "@/components/PrStatusIndicators";

export function mergeMethodLabel(value: MergeMethod, t: UiTranslator): string {
  switch (value) {
    case "merge":
      return t("workspace.git.prMerge.mergeMethodLabelMerge", "Create a merge commit");
    case "squash":
      return t("workspace.git.prMerge.mergeMethodLabelSquash", "Squash and merge");
    case "rebase":
      return t("workspace.git.prMerge.mergeMethodLabelRebase", "Rebase and merge");
    case "rebase_merge":
      return t("workspace.git.prMerge.mergeMethodLabelRebaseMerge", "Rebase, then merge commit");
    case "fast_forward":
      return t("workspace.git.prMerge.mergeMethodLabelFastForward", "Fast-forward");
    case "squash_fast_forward":
      return t(
        "workspace.git.prMerge.mergeMethodLabelSquashFastForward",
        "Squash, then fast-forward",
      );
  }
}

export function mergeMethodDescription(value: MergeMethod, t: UiTranslator): string {
  switch (value) {
    case "merge":
      return t(
        "workspace.git.prMerge.mergeMethodDescriptionMerge",
        "Every commit lands, joined by a merge commit.",
      );
    case "squash":
      return t(
        "workspace.git.prMerge.mergeMethodDescriptionSquash",
        "All commits become one commit on the target.",
      );
    case "rebase":
      return t(
        "workspace.git.prMerge.mergeMethodDescriptionRebase",
        "Commits are replayed onto the target, no merge commit.",
      );
    case "rebase_merge":
      return t(
        "workspace.git.prMerge.mergeMethodDescriptionRebaseMerge",
        "Commits are rebased onto the target, then joined by a merge commit.",
      );
    case "fast_forward":
      return t(
        "workspace.git.prMerge.mergeMethodDescriptionFastForward",
        "The target moves to this branch; refused if it diverged.",
      );
    case "squash_fast_forward":
      return t(
        "workspace.git.prMerge.mergeMethodDescriptionSquashFastForward",
        "All commits become one, then the target moves to it.",
      );
  }
}

/** The label on the button that performs `action`. */
export function mergeActionLabel(
  action: MergeAction,
  status: PrMergeStatus,
  t: UiTranslator = translateUi,
): string {
  switch (action) {
    case "merge":
      return t("workspace.git.prMerge.merge", "Merge");
    case "auto_merge":
      return t("workspace.git.prMerge.mergeWhenReady", "Merge when ready");
    case "enqueue":
      return status.queue === "merge_train"
        ? t("workspace.git.prMerge.addToMergeTrain", "Add to merge train")
        : t("workspace.git.prMerge.addToMergeQueue", "Add to merge queue");
    case "enqueue_when_ready":
      return status.queue === "merge_train"
        ? t("workspace.git.prMerge.addToMergeTrainWhenReady", "Add to merge train when ready")
        : t("workspace.git.prMerge.addToMergeQueueWhenReady", "Add to merge queue when ready");
  }
}

/** One sentence for what the action will do, shown in the confirmation. */
export function mergeActionExplanation(
  action: MergeAction,
  status: PrMergeStatus,
  t: UiTranslator = translateUi,
): string {
  switch (action) {
    case "merge":
      return t(
        "workspace.git.prMerge.mergesRightAwayOnTheForge",
        "Merges right away on the forge.",
      );
    case "auto_merge":
      return t(
        "workspace.git.prMerge.theForgeMergesItByItselfOnce",
        "The forge merges it by itself once the remaining checks pass.",
      );
    case "enqueue":
      return status.queue === "merge_train"
        ? t(
            "workspace.git.prMerge.joinsTheMergeTrainTheForgeMerges",
            "Joins the merge train; the forge merges it once its turn comes and the combined checks pass.",
          )
        : t(
            "workspace.git.prMerge.joinsTheMergeQueueTheForgeMerges",
            "Joins the merge queue; the forge merges it once its turn comes and the combined checks pass.",
          );
    case "enqueue_when_ready":
      return status.queue === "merge_train"
        ? t(
            "workspace.git.prMerge.joinsTheMergeTrainOnceTheRemaining",
            "Joins the merge train once the remaining checks pass, then merges in turn.",
          )
        : t(
            "workspace.git.prMerge.joinsTheMergeQueueOnceTheRemaining",
            "Joins the merge queue once the remaining checks pass, then merges in turn.",
          );
  }
}

export function mergeOutcomeMessage(
  outcome: MergeOutcome,
  status: PrMergeStatus,
  t: UiTranslator = translateUi,
): string {
  switch (outcome) {
    case "merged":
      return t("workspace.git.prMerge.numberMerged", "#{{number}} merged", {
        number: status.pr_number,
      });
    case "merging":
      return t("workspace.git.prMerge.numberIsMerging", "#{{number}} is merging", {
        number: status.pr_number,
      });
    case "auto_merge_enabled":
      return status.queue
        ? status.queue === "merge_train"
          ? t(
              "workspace.git.prMerge.numberJoinsTheMergeTrainOnceChecks",
              "#{{number}} joins the merge train once checks pass",
              { number: status.pr_number },
            )
          : t(
              "workspace.git.prMerge.numberJoinsTheMergeQueueOnceChecks",
              "#{{number}} joins the merge queue once checks pass",
              { number: status.pr_number },
            )
        : t(
            "workspace.git.prMerge.numberWillMergeOnceChecksPass",
            "#{{number}} will merge once checks pass",
            { number: status.pr_number },
          );
    case "queued":
      return status.queue === "merge_train"
        ? t(
            "workspace.git.prMerge.numberAddedToTheMergeTrain",
            "#{{number}} added to the merge train",
            { number: status.pr_number },
          )
        : t(
            "workspace.git.prMerge.numberAddedToTheMergeQueue",
            "#{{number}} added to the merge queue",
            { number: status.pr_number },
          );
  }
}

export function cancelLabel(status: PrMergeStatus, t: UiTranslator = translateUi): string {
  if (status.queue_entry)
    return status.queue === "merge_train"
      ? t("workspace.git.prMerge.removeFromMergeTrain", "Remove from merge train")
      : t("workspace.git.prMerge.removeFromMergeQueue", "Remove from merge queue");
  return t("workspace.git.prMerge.cancelAutoMerge", "Cancel auto-merge");
}

/** The pane's one-line answer to "can this land?". */
export function mergeHeadline(status: PrMergeStatus, t: UiTranslator = translateUi): string {
  if (status.queue_entry) {
    const ahead = status.queue_entry.ahead;
    if (ahead == null)
      return status.queue === "merge_train"
        ? t("workspace.git.prMerge.inTheMergeTrain", "In the merge train")
        : t("workspace.git.prMerge.inTheMergeQueue", "In the merge queue");
    return ahead === 0
      ? status.queue === "merge_train"
        ? t("workspace.git.prMerge.nextInTheMergeTrain", "Next in the merge train")
        : t("workspace.git.prMerge.nextInTheMergeQueue", "Next in the merge queue")
      : status.queue === "merge_train"
        ? t(
            "workspace.git.prMerge.inTheMergeTrainAheadAhead",
            "In the merge train · {{ahead, number}} ahead",
            { ahead },
          )
        : t(
            "workspace.git.prMerge.inTheMergeQueueAheadAhead",
            "In the merge queue · {{ahead, number}} ahead",
            { ahead },
          );
  }
  if (status.auto_merge) {
    return status.queue
      ? status.queue === "merge_train"
        ? t("workspace.git.prMerge.joinsTheMergeTrainWhenReady", "Joins the merge train when ready")
        : t("workspace.git.prMerge.joinsTheMergeQueueWhenReady", "Joins the merge queue when ready")
      : t("workspace.git.prMerge.mergesAutomaticallyWhenReady", "Merges automatically when ready");
  }
  return readinessHeadline(status.readiness, t);
}

function readinessHeadline(value: MergeReadiness, t: UiTranslator): string {
  switch (value) {
    case "ready":
      return t("workspace.git.prMerge.readinessHeadlineReady", "Ready to merge");
    case "blocked":
      return t("workspace.git.prMerge.readinessHeadlineBlocked", "Not ready to merge");
    case "checking":
      return t("workspace.git.prMerge.readinessHeadlineChecking", "Checking mergeability…");
    case "conflicts":
      return t("workspace.git.prMerge.readinessHeadlineConflicts", "Merge conflicts");
    case "behind":
      return t("workspace.git.prMerge.readinessHeadlineBehind", "Out of date with the target");
    case "draft":
      return t("workspace.git.prMerge.readinessHeadlineDraft", "Draft");
    case "closed":
      return t("workspace.git.prMerge.readinessHeadlineClosed", "Closed");
  }
}

export function readinessTone(status: PrMergeStatus): PrIndicatorTone {
  if (status.queue_entry || status.auto_merge) return "ready";
  switch (status.readiness) {
    case "ready":
      return "merged";
    case "conflicts":
      return "danger";
    case "blocked":
    case "behind":
      return "blocked";
    case "checking":
    case "draft":
    case "closed":
      return "neutral";
  }
}

/** "1 of 2 approvals", "2 approvals", "No approvals yet". */
export function approvalsSummary(approvals: PrApprovals, t: UiTranslator = translateUi): string {
  const { approved_count: approved, required } = approvals;
  if (required != null && required > 0) {
    return t(
      "workspace.git.prMerge.approvalsRequiredCount",
      "{{approved, number}} of {{count, number}} approvals",
      {
        count: required,
        approved,
        defaultValue_one: "{{approved, number}} of {{count, number}} approval",
      },
    );
  }
  if (approved === 0) return t("workspace.git.prMerge.noApprovalsYet", "No approvals yet");
  return t("workspace.git.prMerge.approvalsCount", "{{count, number}} approvals", {
    count: approved,
    defaultValue_one: "{{count, number}} approval",
  });
}

export function approvalsTone(approvals: PrApprovals): PrIndicatorTone {
  if (approvals.reviewers.some((reviewer) => reviewer.decision === "changes_requested")) {
    return "blocked";
  }
  if (approvals.satisfied === true) return "ready";
  if (approvals.satisfied === false) return "blocked";
  return approvals.approved_count > 0 ? "ready" : "neutral";
}

/** Why the viewer has no button, when the status alone does not say. */
export function noActionExplanation(
  status: PrMergeStatus,
  t: UiTranslator = translateUi,
): string | null {
  if (status.actions.length > 0 || status.cancellable) return null;
  if (status.readiness === "closed") return null;
  if (status.can_merge === false)
    return t(
      "workspace.git.prMerge.youDonTHavePermissionToMerge",
      "You don't have permission to merge into the target.",
    );
  return null;
}
