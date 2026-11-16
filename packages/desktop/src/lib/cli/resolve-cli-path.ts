import { relativeToProject } from "@/lib/relative-path";

/**
 * Where a path given to `cadencr open` belongs: the project whose checkout, or
 * the conversation whose worktree, contains it. The deepest match wins, so a
 * worktree nested inside its project's checkout claims its own files.
 */

export interface CliProjectRoot {
  id: number;
  path: string;
}

export interface CliWorktreeRoot {
  projectId: number;
  featureId: number;
  path: string;
}

export interface CliPathOwner {
  projectId: number;
  /** Set when the path is inside this conversation's own worktree. */
  featureId: number | null;
  root: string;
  /** The path relative to `root`; empty for the root itself. */
  relativePath: string;
}

function trimTrailingSeparators(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, "") : value;
}

export function resolveCliPathOwner(
  target: string,
  projects: readonly CliProjectRoot[],
  worktrees: readonly CliWorktreeRoot[],
): CliPathOwner | null {
  const candidates = [
    ...projects.map((project) => ({ projectId: project.id, featureId: null, root: project.path })),
    ...worktrees.map((worktree) => ({
      projectId: worktree.projectId,
      featureId: worktree.featureId,
      root: worktree.path,
    })),
  ];
  let best: CliPathOwner | null = null;
  for (const candidate of candidates) {
    const relativePath = relativeToProject(target, candidate.root);
    if (relativePath === null) continue;
    const depth = trimTrailingSeparators(candidate.root).length;
    if (best && depth <= trimTrailingSeparators(best.root).length) continue;
    best = { ...candidate, relativePath };
  }
  return best;
}

export interface CliFeatureCandidate {
  id: number;
  projectId: number;
  /** ISO timestamp; the list endpoints fill it. */
  lastActivityAt: string | null;
}

/**
 * The conversation a file of the project's own checkout opens in: the one this
 * device last had open when it works there, else the most recently active one
 * working in the checkout (not in a worktree of its own). `null` when none does.
 */
export function chooseCheckoutFeature(
  features: readonly CliFeatureCandidate[],
  worktreeFeatureIds: ReadonlySet<number>,
  lastOpenedFeatureId: number | null,
): number | null {
  const inCheckout = features.filter((feature) => !worktreeFeatureIds.has(feature.id));
  if (lastOpenedFeatureId !== null && inCheckout.some((f) => f.id === lastOpenedFeatureId)) {
    return lastOpenedFeatureId;
  }
  const activity = (feature: CliFeatureCandidate): number =>
    Date.parse(feature.lastActivityAt ?? "") || 0;
  const sorted = [...inCheckout].sort((a, b) => activity(b) - activity(a));
  return sorted[0]?.id ?? null;
}
