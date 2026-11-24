import {
  ArchiveIcon,
  GitBranchIcon,
  GitCommitVerticalIcon,
  GitCompareArrowsIcon,
  GitPullRequestIcon,
  PencilLineIcon,
  type LucideIcon,
} from "lucide-react";
import type { UiTranslator } from "@/lib/i18n/ui";
import type { ShortcutId } from "@/lib/shortcuts/registry";
import type { GitViewMode } from "./GitTabToggle";

/** Below this, a wait is not a wait — it is a flicker. */
export const GIT_VIEW_SPINNER_DELAY_MS = 400;

export interface GitViewDefinition {
  mode: GitViewMode;
  icon: LucideIcon;
  /** The view's name; the target and proposal views name themselves from live data. */
  label: string;
  hint: string;
  shortcutId: ShortcutId;
}

/**
 * The Git tab's views, in order: the desktop strip (`GitTabToggle`) and the
 * phone picker (`PhoneGitViewPicker`) both list these.
 */
export function gitViews(t: UiTranslator) {
  return [
    {
      mode: "uncommitted",
      icon: PencilLineIcon,
      label: t("workspace.git.gitTabToggle.changes", "Changes"),
      hint: t("workspace.git.gitTabToggle.workingTreeChanges", "Working-tree changes"),
      shortcutId: "git-show-uncommitted",
    },
    {
      mode: "vs-target",
      icon: GitCompareArrowsIcon,
      label: t("workspace.git.gitTabToggle.compareWithTarget", "vs target"),
      hint: t("workspace.git.gitTabToggle.diffAgainstTarget", "Diff against the target branch"),
      shortcutId: "git-show-vs-target",
    },
    {
      mode: "pr",
      icon: GitPullRequestIcon,
      label: t("workspace.git.gitTabToggle.pullRequest", "Pull request"),
      hint: t(
        "workspace.git.gitViews.pullRequestDetails",
        "Pull request status, checks, and comments",
      ),
      shortcutId: "git-show-pull-request",
    },
    {
      mode: "graph",
      icon: GitCommitVerticalIcon,
      label: t("workspace.git.gitTabToggle.commits", "Commits"),
      hint: t("workspace.git.gitTabToggle.commitHistoryGraph", "Commit history graph"),
      shortcutId: "git-show-commits",
    },
    {
      mode: "branches",
      icon: GitBranchIcon,
      label: t("workspace.git.gitTabToggle.branches", "Branches"),
      hint: t("workspace.git.gitTabToggle.localAndRemoteBranches", "Local and remote branches"),
      shortcutId: "git-show-branches",
    },
    {
      mode: "stashes",
      icon: ArchiveIcon,
      label: t("workspace.git.gitTabToggle.stashes", "Stashes"),
      hint: t("workspace.git.gitTabToggle.stashedChanges", "Stashed changes"),
      shortcutId: "git-show-stashes",
    },
  ] as const satisfies readonly GitViewDefinition[];
}

/** The target diff's name: "vs main", or "vs target" before the branch is known. */
export function gitTargetLabel(targetBranch: string | undefined, t: UiTranslator): string {
  return targetBranch?.trim()
    ? t("workspace.git.gitTabToggle.compareWithBranch", "vs {{branch}}", { branch: targetBranch })
    : t("workspace.git.gitTabToggle.compareWithTarget", "vs target");
}
