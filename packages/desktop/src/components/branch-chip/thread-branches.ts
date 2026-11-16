import type { GitStatusSnapshot, ThreadBranch } from "@/api/generated";

/**
 * The conversation's branches, current first. A snapshot the backend could
 * not enrich (degraded, or from before the list existed) still yields the
 * live checkout, so the chip never has less to show than it used to.
 */
export function threadBranchesOf(snapshot: GitStatusSnapshot): ThreadBranch[] {
  if (snapshot.thread_branches && snapshot.thread_branches.length > 0) {
    return snapshot.thread_branches;
  }
  if (!snapshot.current_branch) return [];
  return [
    {
      name: snapshot.current_branch,
      origin: "head",
      target_branch: snapshot.target_branch,
      is_current: true,
      last_seen_at: null,
    },
  ];
}

/**
 * What the directory has checked out, and its entry when it is one of the
 * conversation's branches. The header always names the checkout: a
 * worktree-free conversation can sit on a branch that isn't its own (another
 * conversation moved the project directory, or it is back on the trunk), and
 * hiding that is how a commit lands on the wrong branch.
 */
export interface ThreadCheckout {
  name: string;
  /** `undefined` when the checkout is not one of the conversation's branches. */
  branch: ThreadBranch | undefined;
}

export function checkoutOf(
  snapshot: GitStatusSnapshot,
  branches: readonly ThreadBranch[],
): ThreadCheckout | undefined {
  const name = snapshot.current_branch || branches[0]?.name;
  if (!name) return undefined;
  return { name, branch: branches.find((branch) => branch.name === name) };
}
