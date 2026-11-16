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
  MergeQueueKind,
  MergeReadiness,
  PrApprovals,
  PrMergeStatus,
} from "@/api/generated";
import type { PrIndicatorTone } from "@/components/PrStatusIndicators";

export const MERGE_METHOD_LABEL: Record<MergeMethod, string> = {
  merge: "Create a merge commit",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
  rebase_merge: "Rebase, then merge commit",
  fast_forward: "Fast-forward",
  squash_fast_forward: "Squash, then fast-forward",
};

export const MERGE_METHOD_DESCRIPTION: Record<MergeMethod, string> = {
  merge: "Every commit lands, joined by a merge commit.",
  squash: "All commits become one commit on the target.",
  rebase: "Commits are replayed onto the target, no merge commit.",
  rebase_merge: "Commits are rebased onto the target, then joined by a merge commit.",
  fast_forward: "The target moves to this branch; refused if it diverged.",
  squash_fast_forward: "All commits become one, then the target moves to it.",
};

export function queueNoun(kind: MergeQueueKind): string {
  return kind === "merge_train" ? "merge train" : "merge queue";
}

/** The label on the button that performs `action`. */
export function mergeActionLabel(action: MergeAction, status: PrMergeStatus): string {
  const noun = status.queue ? queueNoun(status.queue) : "merge queue";
  switch (action) {
    case "merge":
      return "Merge";
    case "auto_merge":
      return "Merge when ready";
    case "enqueue":
      return `Add to ${noun}`;
    case "enqueue_when_ready":
      return `Add to ${noun} when ready`;
  }
}

/** One sentence for what the action will do, shown in the confirmation. */
export function mergeActionExplanation(action: MergeAction, status: PrMergeStatus): string {
  const noun = status.queue ? queueNoun(status.queue) : "merge queue";
  switch (action) {
    case "merge":
      return "Merges right away on the forge.";
    case "auto_merge":
      return "The forge merges it by itself once the remaining checks pass.";
    case "enqueue":
      return `Joins the ${noun}; the forge merges it once its turn comes and the combined checks pass.`;
    case "enqueue_when_ready":
      return `Joins the ${noun} once the remaining checks pass, then merges in turn.`;
  }
}

export function mergeOutcomeMessage(outcome: MergeOutcome, status: PrMergeStatus): string {
  const noun = status.queue ? queueNoun(status.queue) : "merge queue";
  switch (outcome) {
    case "merged":
      return `#${status.pr_number} merged`;
    case "merging":
      return `#${status.pr_number} is merging`;
    case "auto_merge_enabled":
      return status.queue
        ? `#${status.pr_number} joins the ${noun} once checks pass`
        : `#${status.pr_number} will merge once checks pass`;
    case "queued":
      return `#${status.pr_number} added to the ${noun}`;
  }
}

export function cancelLabel(status: PrMergeStatus): string {
  if (status.queue_entry) return `Remove from ${queueNoun(status.queue ?? "merge_queue")}`;
  return "Cancel auto-merge";
}

/** The pane's one-line answer to "can this land?". */
export function mergeHeadline(status: PrMergeStatus): string {
  if (status.queue_entry) {
    const noun = queueNoun(status.queue ?? "merge_queue");
    const ahead = status.queue_entry.ahead;
    if (ahead == null) return `In the ${noun}`;
    return ahead === 0 ? `Next in the ${noun}` : `In the ${noun} · ${ahead} ahead`;
  }
  if (status.auto_merge) {
    return status.queue
      ? `Joins the ${queueNoun(status.queue)} when ready`
      : "Merges automatically when ready";
  }
  return READINESS_HEADLINE[status.readiness];
}

const READINESS_HEADLINE: Record<MergeReadiness, string> = {
  ready: "Ready to merge",
  blocked: "Not ready to merge",
  checking: "Checking mergeability…",
  conflicts: "Merge conflicts",
  behind: "Out of date with the target",
  draft: "Draft",
  closed: "Closed",
};

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
export function approvalsSummary(approvals: PrApprovals): string {
  const { approved_count: approved, required } = approvals;
  if (required != null && required > 0) {
    return `${approved} of ${required} ${required === 1 ? "approval" : "approvals"}`;
  }
  if (approved === 0) return "No approvals yet";
  return `${approved} ${approved === 1 ? "approval" : "approvals"}`;
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
export function noActionExplanation(status: PrMergeStatus): string | null {
  if (status.actions.length > 0 || status.cancellable) return null;
  if (status.readiness === "closed") return null;
  if (status.can_merge === false) return "You don't have permission to merge into the target.";
  return null;
}
