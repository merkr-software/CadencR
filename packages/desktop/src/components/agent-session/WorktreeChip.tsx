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
}

/**
 * Branch + worktree selection chip. Shared by `MetaBar` (inline, wide screens)
 * and `MetaBarSecondary` (below the prompt on narrow/mobile widths) so the two
 * placements stay identical. Memoized like the sibling chips — it sits next to
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
    />
  );
});
