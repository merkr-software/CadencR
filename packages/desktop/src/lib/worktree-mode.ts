/**
 * Explicit pre-first-prompt branch/worktree behavior.
 *
 * Replaces the old boolean "Use worktree" toggle with the full 2×2 matrix the
 * user actually reasons about — *which* branch the agent runs on (the selected
 * existing branch, or a new branch forked from it) crossed with *where* it
 * runs (the project folder, or a dedicated worktree):
 *
 *   | mode                   | branch            | location        | backend         |
 *   | ---------------------- | ----------------- | --------------- | --------------- |
 *   | on_branch              | existing selected | project folder  | skip            |
 *   | branch_worktree        | existing selected | worktree        | reuse           |
 *   | from_branch            | new (from base)   | project folder  | project_branch  |
 *   | from_branch_worktree   | new (from base)   | worktree        | new             |
 *
 * `branch_worktree` maps to the backend `reuse` mode either way: when the
 * branch already has a worktree we attach to it ("Reuse worktree"), otherwise
 * the backend creates a fresh worktree on the same branch ("New worktree").
 * The label adapts; the backend action is identical.
 */
import type { BranchInfo } from "@/api/generated";
import type { DefaultWorktreeMode } from "@/lib/default-worktree-mode";

export type WorktreeMode = "on_branch" | "branch_worktree" | "from_branch" | "from_branch_worktree";

export const WORKTREE_MODES: readonly WorktreeMode[] = [
  "on_branch",
  "branch_worktree",
  "from_branch",
  "from_branch_worktree",
];

/**
 * State of the branch the choice resolves against — drives which modes are
 * offered and how `branch_worktree` is labelled.
 */
export interface BranchWorktreeState {
  /** Explicit pick or the project's current branch when nothing is picked. */
  effectiveBranch: string | null;
  /**
   * The effective branch is checked out in the project's *main* working tree
   * (its attached worktree path equals the project path). Git can't check the
   * same branch out in a second worktree, so reuse/new-worktree is impossible
   * for it.
   */
  isOnProjectPath: boolean;
  /** The effective branch already lives in a *separate* worktree (one attached
   *  to a path other than the project's). */
  hasWorktree: boolean;
  /** The effective branch is a local branch (remote-tracking refs can't be reused/worktree'd directly). */
  isLocal: boolean;
}

/** Compare two filesystem paths for the "same directory" check, tolerating a
 *  trailing slash. (git reports worktree paths without one; the project path
 *  may or may not carry one.) */
function samePath(a: string, b: string | undefined): boolean {
  if (b == null) return false;
  const norm = (p: string): string => p.replace(/\/+$/, "");
  return norm(a) === norm(b);
}

export function branchWorktreeState(args: {
  selectedBranch: string | null;
  defaultBranch: string | undefined;
  branches: BranchInfo[] | undefined;
  projectPath: string | undefined;
}): BranchWorktreeState {
  const { selectedBranch, defaultBranch, branches, projectPath } = args;
  const effectiveBranch = selectedBranch ?? defaultBranch ?? null;
  const matched =
    effectiveBranch == null ? undefined : branches?.find((b) => b.name === effectiveBranch);
  const attachedPath = matched?.attached_worktree_path ?? null;
  // A branch occupying the project's main working tree reports that path as its
  // worktree — that's the one case reuse/new-worktree can't apply (git forbids
  // the same branch in two worktrees). The `=== defaultBranch` fallback covers
  // the project's current branch even before the branch list has loaded; the
  // attachment check covers a freshly-switched branch the (possibly stale)
  // `defaultBranch` lookup hasn't caught up to yet.
  const isOnProjectPath =
    (effectiveBranch != null && effectiveBranch === defaultBranch) ||
    (attachedPath != null && samePath(attachedPath, projectPath));
  // "Has a worktree" means a *separate* worktree — never the project path.
  const hasWorktree = attachedPath != null && !isOnProjectPath;
  const isLocal = matched ? matched.is_local !== false : true;
  return { effectiveBranch, isOnProjectPath, hasWorktree, isLocal };
}

/**
 * `branch_worktree` is impossible for the branch already checked out in the
 * project path (git refuses to check the same branch out in two worktrees) and
 * for remote-tracking refs (there's no local branch to attach). In those cases
 * the user wants `from_branch_worktree` instead.
 */
export function isWorktreeModeDisabled(mode: WorktreeMode, state: BranchWorktreeState): boolean {
  if (mode !== "branch_worktree") return false;
  return state.isOnProjectPath || !state.isLocal;
}

export interface WorktreeModeDescriptor {
  mode: WorktreeMode;
  label: string;
  description: string;
}

export function describeWorktreeMode(
  mode: WorktreeMode,
  state: BranchWorktreeState,
): WorktreeModeDescriptor {
  const branch = state.effectiveBranch ?? "the current branch";
  switch (mode) {
    case "on_branch":
      return {
        mode,
        label: "On branch",
        description: `Work directly on ${branch} in the project folder.`,
      };
    case "branch_worktree":
      return {
        mode,
        label: state.hasWorktree ? "Reuse worktree" : "New worktree",
        description: state.hasWorktree
          ? `Reuse the worktree already attached to ${branch}.`
          : `Create a dedicated worktree for ${branch}.`,
      };
    case "from_branch":
      return {
        mode,
        label: "From branch",
        description: `Create a new branch from ${branch}, in the project folder.`,
      };
    case "from_branch_worktree":
      return {
        mode,
        label: "From branch with worktree",
        description: `Create a new branch from ${branch} in a new worktree.`,
      };
  }
}

/**
 * One-line, future-tense summary of what the **first prompt** will do for the
 * current mode + branch selection. The pre-prompt chip only configures intent —
 * the branch checkout / worktree provisioning is deferred until the first
 * message is sent (see `WebSocketSessionFeatureBlockTabs`' send handler). This
 * hint spells that out so the chip never implies the branch already switched.
 *
 * Returns `null` for "On branch" on the current branch, where nothing is
 * deferred and there's nothing to announce.
 */
export function firstPromptBranchEffect(args: {
  mode: WorktreeMode;
  selectedBranch: string | null;
  defaultBranch: string | undefined;
}): string | null {
  const { mode, selectedBranch, defaultBranch } = args;
  const branch = selectedBranch ?? defaultBranch ?? "the current branch";
  const switching = selectedBranch != null && selectedBranch !== defaultBranch;
  const suffix = "when you send your first message";
  switch (mode) {
    case "on_branch":
      return switching ? `Switches the project to ${branch} ${suffix}.` : null;
    case "from_branch":
      return `Creates a new branch from ${branch} ${suffix}.`;
    case "branch_worktree":
      return `Sets up a worktree on ${branch} ${suffix}.`;
    case "from_branch_worktree":
      return `Creates a new branch from ${branch} in a worktree ${suffix}.`;
  }
}

/** Project default (`new | skip`) mapped onto the richer mode set. */
export function defaultWorktreeMode(projectDefault: DefaultWorktreeMode): WorktreeMode {
  return projectDefault === "new" ? "from_branch_worktree" : "on_branch";
}

/**
 * Inverse of {@link defaultWorktreeMode}: the project-default value to persist
 * for a chosen mode, or `null` for branch-specific modes that shouldn't move
 * the saved default (reuse / from_branch always target a specific branch).
 */
export function worktreeModeToProjectDefault(mode: WorktreeMode): DefaultWorktreeMode | null {
  if (mode === "from_branch_worktree") return "new";
  if (mode === "on_branch") return "skip";
  return null;
}

/**
 * What the first prompt resolves a mode into. The two project-path modes are
 * worktree-free and run in the project folder: `skip` switches to an existing
 * branch (a pre-send `git checkout`), while `project_branch` forks a new branch
 * named after the feature — done by the backend *after* auto-naming so the name
 * matches the prompt (sent as `new_project_branch`, no worktree, no setup). The
 * two worktree modes (`reuse` / `new`) persist feature settings that the
 * backend's `ensure_worktree` reads. `base`/`checkout` of `null` means the
 * project's current HEAD.
 */
export type ResolvedWorktreeChoice =
  | { backendMode: "skip"; checkout: string | null }
  | { backendMode: "project_branch"; base: string | null }
  | { backendMode: "reuse"; reuseBranch: string }
  | { backendMode: "new"; baseBranch: string | null };

export function resolveWorktreeChoice(args: {
  mode: WorktreeMode;
  selectedBranch: string | null;
  defaultBranch: string | undefined;
}): ResolvedWorktreeChoice {
  const { mode, selectedBranch, defaultBranch } = args;
  // An explicit pick that differs from the project's current branch. `null`
  // means "use the project's current HEAD" — the default fork point.
  const explicitBranch =
    selectedBranch != null && selectedBranch !== defaultBranch ? selectedBranch : null;
  switch (mode) {
    case "on_branch":
      return { backendMode: "skip", checkout: explicitBranch };
    case "branch_worktree":
      return { backendMode: "reuse", reuseBranch: selectedBranch ?? defaultBranch ?? "" };
    case "from_branch":
      return { backendMode: "project_branch", base: explicitBranch };
    case "from_branch_worktree":
      return { backendMode: "new", baseBranch: explicitBranch };
  }
}
