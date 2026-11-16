import { memo } from "react";
import { WorktreeButtonGroup } from "./WorktreePopover";
import type { WorktreeMode } from "@/lib/worktree-mode";

export interface WorktreeChipProps {
  /** Project the branch list is scoped to. */
  worktreeProjectId?: number;
  worktreeDefaultBranch?: string;
  /** Project's main working-tree path; gates "reuse worktree" for its branch. */
  worktreeProjectPath?: string;
  /** Explicit branch/worktree behavior + its setter. */
  worktreeMode?: WorktreeMode;
  onWorktreeModeChange?: (mode: WorktreeMode) => void;
  worktreeSelectedBranch?: string | null;
  onWorktreeBranchChange?: (next: string | null) => void;
  /** Subset of behaviors to offer — see `WorktreeButtonGroup`. Defaults to all
   *  four, i.e. the full session chip. */
  worktreeModes?: readonly WorktreeMode[];
  /**
   * Bind the `agent-worktree-mode` cycle shortcut, and advertise it in the mode
   * popover. On by default for the session chip. The schedule editor turns it
   * off: it renders outside `FeatureLayoutContext`, where the `"agent"` scope
   * gate is inert (`useIsTabFocused`), so its chip would answer the key from
   * anywhere — including over a session chip already bound to it.
   */
  enableModeShortcut?: boolean;
  /** `manifest`: inline tokens of the composer's launch sentence. */
  variant?: "chip" | "manifest";
}

/**
 * Branch + worktree selection: the tokens of the composer's launch sentence
 * (`manifest`), or a chip. Memoized like the sibling chips — it sits next to
 * the agent stream, so it must not re-render on every streamed token.
 */
export const WorktreeChip = memo(function WorktreeChip({
  worktreeProjectId,
  worktreeDefaultBranch,
  worktreeProjectPath,
  worktreeMode,
  onWorktreeModeChange,
  worktreeSelectedBranch,
  onWorktreeBranchChange,
  worktreeModes,
  enableModeShortcut,
  variant,
}: WorktreeChipProps) {
  if (
    worktreeProjectId == null ||
    !onWorktreeModeChange ||
    !onWorktreeBranchChange ||
    !worktreeMode
  ) {
    return null;
  }
  return (
    <WorktreeButtonGroup
      projectId={worktreeProjectId}
      defaultBranch={worktreeDefaultBranch}
      projectPath={worktreeProjectPath}
      mode={worktreeMode}
      onModeChange={onWorktreeModeChange}
      selectedBranch={worktreeSelectedBranch ?? null}
      onSelectedBranchChange={onWorktreeBranchChange}
      modes={worktreeModes}
      enableModeShortcut={enableModeShortcut}
      variant={variant}
    />
  );
});
