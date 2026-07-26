import { type ReactElement } from "react";
import { useGetBranch, type ScheduleTarget } from "@/api/generated";
import { WorktreeChip } from "@/components/agent-session/WorktreeChip";
import { Skeleton } from "@/components/ui/skeleton";
import {
  applyScheduleWorktree,
  scheduleWorktreeBranch,
  scheduleWorktreeMode,
  SCHEDULE_WORKTREE_MODES,
} from "@/lib/schedules/worktree";
import type { WorktreeMode } from "@/lib/worktree-mode";

/**
 * A scheduled run never checks a branch out, so "On branch <something else>"
 * can't be honored. Picking another branch there means the user wants the run
 * to happen on it — which for a schedule means a worktree.
 */
function branchMode(mode: WorktreeMode, branch: string | null): WorktreeMode {
  return mode === "on_branch" && branch != null ? "branch_worktree" : mode;
}

export function ScheduleWorktreeChip({
  target,
  onChange,
  projectPath,
}: {
  target: ScheduleTarget;
  onChange: (next: ScheduleTarget) => void;
  /** Gates "reuse worktree" for the branch already checked out there. */
  projectPath?: string;
}): ReactElement {
  const projectId = target.project_id ?? undefined;
  const { data: branch, isLoading } = useGetBranch(
    { project_id: projectId ?? 0 },
    { query: { enabled: projectId != null } },
  );
  const defaultBranch = branch?.branch ?? undefined;
  const mode = scheduleWorktreeMode(target);
  const selectedBranch = scheduleWorktreeBranch(target);

  // Every choice this chip offers is phrased against the project's current
  // branch, and picking one before it arrives writes the wrong base branch onto
  // the target. Wait for it rather than offering a decision built on a blank.
  if (projectId != null && isLoading) {
    return (
      <Skeleton
        className="h-6 w-28 rounded-full"
        aria-busy="true"
        aria-label="Loading branch options"
      />
    );
  }

  return (
    <WorktreeChip
      worktreeProjectId={projectId}
      worktreeDefaultBranch={defaultBranch}
      worktreeProjectPath={projectPath}
      worktreeMode={mode}
      onWorktreeModeChange={(next) =>
        onChange(applyScheduleWorktree(target, next, selectedBranch, defaultBranch))
      }
      worktreeSelectedBranch={selectedBranch}
      onWorktreeBranchChange={(next) =>
        onChange(applyScheduleWorktree(target, branchMode(mode, next), next, defaultBranch))
      }
      worktreeModes={SCHEDULE_WORKTREE_MODES}
    />
  );
}
