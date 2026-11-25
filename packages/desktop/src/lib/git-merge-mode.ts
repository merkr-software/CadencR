import { type UiTranslator } from "@/lib/i18n/ui";
export const GIT_MERGE_MODE_KEY = "git_merge_mode";

export const GIT_MERGE_MODES = ["default", "no_ff", "ff_only", "squash"] as const;

export type GitMergeMode = (typeof GIT_MERGE_MODES)[number];

export const DEFAULT_GIT_MERGE_MODE: GitMergeMode = "no_ff";

export interface GitMergeModeOption {
  value: GitMergeMode;
  /** Display name (e.g. "No fast-forward"). */
  label: string;
  /** Git CLI flag (e.g. "--no-ff") rendered as a chip. */
  flag: string;
  description: string;
}

const FLAGS = {
  default: "default",
  no_ff: "--no-ff",
  ff_only: "--ff-only",
  squash: "--squash",
} satisfies Record<GitMergeMode, string>;

export function gitMergeModeOptions(t: UiTranslator): GitMergeModeOption[] {
  return [
    {
      value: "default",
      label: t("workspace.git.git-merge-mode.gitDefault", "Git default"),
      flag: FLAGS.default,
      description: t(
        "workspace.git.git-merge-mode.useGitSDefaultMergeBehavior",
        "Use Git's default merge behavior.",
      ),
    },
    {
      value: "no_ff",
      label: t("workspace.git.git-merge-mode.noFastForward", "No fast-forward"),
      flag: FLAGS.no_ff,
      description: t(
        "workspace.git.git-merge-mode.alwaysCreateAMergeCommit",
        "Always create a merge commit.",
      ),
    },
    {
      value: "ff_only",
      label: t("workspace.git.git-merge-mode.fastForwardOnly", "Fast-forward only"),
      flag: FLAGS.ff_only,
      description: t(
        "workspace.git.git-merge-mode.onlyMergeWhenAFastForwardIs",
        "Only merge when a fast-forward is possible.",
      ),
    },
    {
      value: "squash",
      label: t("workspace.git.git-merge-mode.squash", "Squash"),
      flag: FLAGS.squash,
      description: t(
        "workspace.git.git-merge-mode.stageTheCombinedChangesWithoutCreatingA",
        "Stage the combined changes without creating a merge commit.",
      ),
    },
  ];
}

export function parseGitMergeMode(value: string | null | undefined): GitMergeMode {
  return GIT_MERGE_MODES.includes(value as GitMergeMode)
    ? (value as GitMergeMode)
    : DEFAULT_GIT_MERGE_MODE;
}

/** CLI flag (e.g. "--no-ff") for a given merge mode — used by buttons / chips. */
export function gitMergeModeFlag(value: GitMergeMode): string {
  return FLAGS[value] ?? FLAGS.no_ff;
}

/**
 * Token-driven color for each merge mode's CLI-flag chip. Shared by the
 * settings page and the in-feature Merge dialog so the two views stay
 * visually in lockstep — same hue, same label.
 *
 * `default` uses `--foreground` (not `--muted-foreground`) so the flag stays
 * readable against the chip's `bg-muted` surface across both themes.
 */
export const GIT_MERGE_FLAG_COLOR_VAR: Record<GitMergeMode, string> = {
  default: "var(--foreground)",
  no_ff: "var(--acc-purple)",
  ff_only: "var(--acc-cyan)",
  squash: "var(--acc-orange)",
};
