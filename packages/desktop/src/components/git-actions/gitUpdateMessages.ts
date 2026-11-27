import { translateUi, type UiTranslator } from "@/lib/i18n/ui";
import type { GitOperationKind } from "@/api/generated";

export function gitUpdateContinueDisabledReason(
  conflictCount: number,
  t: UiTranslator = translateUi,
): string | null {
  if (conflictCount <= 0) return null;
  return t(
    "workspace.git.gitUpdateMessages.stageConflictsFirst",
    "Resolve and stage {{count, number}} conflicting files first",
    {
      count: conflictCount,
      defaultValue_one: "Resolve and stage {{count, number}} conflicting file first",
    },
  );
}

/**
 * Operation-aware Continue/Abort label (e.g. "Continue merge", "Abort rebase").
 * Preferred over the internal "update" wording wherever the user is looking at a
 * concrete paused merge or rebase.
 */
export function gitUpdateActionLabel(
  action: "continue" | "abort",
  operation: GitOperationKind,
  t: UiTranslator = translateUi,
): string {
  return action === "continue"
    ? operation === "rebase"
      ? t("workspace.git.gitUpdateMessages.continueRebase", "Continue rebase")
      : t("workspace.git.gitUpdateMessages.continueMerge", "Continue merge")
    : operation === "rebase"
      ? t("workspace.git.gitUpdateMessages.abortRebase", "Abort rebase")
      : t("workspace.git.gitUpdateMessages.abortMerge", "Abort merge");
}

export function describeGitUpdateConflictFiles(
  files: string[],
  t: UiTranslator = translateUi,
): string {
  if (files.length === 0) {
    return t(
      "workspace.git.gitUpdateMessages.resolveConflicts",
      "Resolve the conflicts in Uncommitted, then continue or abort.",
    );
  }
  const visible = files.slice(0, 3).join(", ");
  const overflow = files.length - 3;
  return overflow > 0
    ? t(
        "workspace.git.gitUpdateMessages.conflictOverflow",
        "{{files}}, and {{count, number}} more",
        {
          files: visible,
          count: overflow,
        },
      )
    : visible;
}
