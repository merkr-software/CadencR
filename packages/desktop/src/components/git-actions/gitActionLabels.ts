import type { GitOperationKind, PrSummary } from "@/api/generated";
import type { UiTranslator } from "@/lib/i18n/ui";
import { prNoun } from "@/lib/open-pull-request";
import type { PrimaryGitAction } from "./useGitAction";

export function updateBlockedReason(
  updatePending: boolean,
  operation: GitOperationKind | null,
  t: UiTranslator,
): string | null {
  if (updatePending) {
    return t("workspace.git.useGitAction.updateRequestInProgress", "Update request in progress");
  }
  if (!operation) return null;
  return operation === "rebase"
    ? t("workspace.git.useGitAction.activeRebase", "Finish or abort the active rebase update first")
    : t("workspace.git.useGitAction.activeMerge", "Finish or abort the active merge update first");
}

export function compareActionLabel(label: string | null | undefined, t: UiTranslator): string {
  switch (label) {
    case null:
    case undefined:
    case "Open pull request":
      return t("workspace.git.useGitAction.openPullRequest", "Open pull request");
    case "Open merge request":
      return t("workspace.git.useGitAction.openMergeRequest", "Open merge request");
    case "Open compare":
      return t("workspace.git.gitActionPopover.openCompare", "Open compare");
    default:
      return label;
  }
}

export function viewProposalLabel(proposal: PrSummary, t: UiTranslator): string {
  const { number } = proposal;
  switch (prNoun(proposal)) {
    case "pull request":
      return t("workspace.git.useGitAction.viewPullRequest", "View pull request #{{number}}", {
        number,
      });
    case "merge request":
      return t("workspace.git.useGitAction.viewMergeRequest", "View merge request #{{number}}", {
        number,
      });
    default:
      return t("workspace.git.useGitAction.viewProposal", "View {{proposal}} #{{number}}", {
        proposal: proposal.pr_label,
        number,
      });
  }
}

export function primaryActionLabel(
  primary: PrimaryGitAction | null,
  updatePending: boolean,
  compareLabel: string,
  commitDisabled: string | null,
  t: UiTranslator,
): string {
  if (updatePending) return t("workspace.git.useGitAction.updating", "Updating…");
  switch (primary) {
    case "commit":
      return t("workspace.git.useGitAction.commit", "Commit");
    case "update":
      return t("workspace.git.useGitAction.update", "Update");
    case "push":
      return t("workspace.git.useGitAction.push", "Push");
    case "pr":
      return compareLabel;
    case "merge":
      return t("workspace.git.useGitAction.merge", "Merge");
    case null:
      return commitDisabled ?? t("workspace.git.useGitAction.noAction", "No action");
  }
}
