import { type UiTranslator } from "@/lib/i18n/ui";
export const GIT_DIFF_VIEW_MODE_KEY = "git_diff_view_mode";

export const GIT_DIFF_VIEW_MODES = ["unified", "split"] as const;

export type GitDiffViewMode = (typeof GIT_DIFF_VIEW_MODES)[number];

export const DEFAULT_GIT_DIFF_VIEW_MODE: GitDiffViewMode = "unified";

export interface GitDiffViewModeOption {
  value: GitDiffViewMode;
  label: string;
  description: string;
}

export function gitDiffViewModeOptions(t: UiTranslator): GitDiffViewModeOption[] {
  return [
    {
      value: "unified",
      label: t("workspace.git.git-diff-view-mode.unified", "Unified"),
      description: t(
        "workspace.git.git-diff-view-mode.renderDiffsInASingleColumnUnified",
        "Render diffs in a single-column unified format.",
      ),
    },
    {
      value: "split",
      label: t("workspace.git.git-diff-view-mode.split", "Split"),
      description: t(
        "workspace.git.git-diff-view-mode.renderDiffsWithSideBySideBefore",
        "Render diffs with side-by-side before/after columns.",
      ),
    },
  ];
}

export function parseGitDiffViewMode(value: string | null | undefined): GitDiffViewMode {
  return GIT_DIFF_VIEW_MODES.includes(value as GitDiffViewMode)
    ? (value as GitDiffViewMode)
    : DEFAULT_GIT_DIFF_VIEW_MODE;
}
