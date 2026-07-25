/**
 * Translation between a schedule target's stored worktree fields and the
 * session composer's `WorktreeMode`, so the schedule editor can drive the very
 * same chip a conversation uses.
 *
 * Three of the four session behaviors survive the trip. "From branch"
 * (`project_branch`) does not: it forks a branch named after the conversation
 * as part of the live prompt path, which a scheduled dispatch never runs — so
 * it is left out of the list rather than offered and silently ignored.
 */
import type { ScheduleTarget } from "@/api/generated";
import { resolveWorktreeChoice, type WorktreeMode } from "@/lib/worktree-mode";

export const SCHEDULE_WORKTREE_MODES: readonly WorktreeMode[] = [
  "on_branch",
  "branch_worktree",
  "from_branch_worktree",
];

export function scheduleWorktreeMode(target: ScheduleTarget): WorktreeMode {
  if (target.worktree_mode === "reuse") return "branch_worktree";
  if (target.worktree_mode === "new") return "from_branch_worktree";
  return "on_branch";
}

/** The branch the current mode resolves against, or `null` for the project's. */
export function scheduleWorktreeBranch(target: ScheduleTarget): string | null {
  if (target.worktree_mode === "reuse") return target.reuse_branch ?? null;
  if (target.worktree_mode === "new") return target.base_branch ?? null;
  return null;
}

/**
 * Fold a (mode, branch) choice back into the target. `skip` carries no branch:
 * the run works in the project folder on whatever branch it happens to be on,
 * and nothing checks anything out at 3am.
 */
export function applyScheduleWorktree(
  target: ScheduleTarget,
  mode: WorktreeMode,
  selectedBranch: string | null,
  defaultBranch: string | undefined,
): ScheduleTarget {
  const choice = resolveWorktreeChoice({ mode, selectedBranch, defaultBranch });
  switch (choice.backendMode) {
    case "reuse":
      return {
        ...target,
        worktree_mode: "reuse",
        reuse_branch: choice.reuseBranch || undefined,
        base_branch: undefined,
      };
    case "new":
      return {
        ...target,
        worktree_mode: "new",
        reuse_branch: undefined,
        base_branch: choice.baseBranch ?? undefined,
      };
    default:
      return {
        ...target,
        worktree_mode: "skip",
        reuse_branch: undefined,
        base_branch: undefined,
      };
  }
}
