import type { Feature, FeatureWorktreeInfo } from "@/api/generated";
import { getFileName } from "@/lib/file-language";

export interface WorktreeFeatureGroup {
  key: string;
  label: string;
  features: Feature[];
}

export interface PartitionedFeatures {
  /** Active features the user pinned — rendered in a dedicated top section. */
  pinnedFeatures: Feature[];
  /** Unpinned features sharing a non-main worktree path (>= 2 per path). */
  worktreeGroups: WorktreeFeatureGroup[];
  /** Remaining unpinned active features rendered as a flat list. */
  flatActiveFeatures: Feature[];
}

/**
 * Split a project's active features into the pinned section, worktree groups,
 * and the flat list. Pinned features are pulled out first so a pinned
 * conversation never also appears inside a worktree group or the flat list.
 * Group order and intra-group order both follow `activeFeatures` iteration
 * order (already recency-sorted by the backend).
 */
export function partitionActiveFeatures(
  activeFeatures: readonly Feature[],
  worktreeByFeatureId: ReadonlyMap<number, FeatureWorktreeInfo>,
  projectPath: string,
): PartitionedFeatures {
  const pinnedFeatures: Feature[] = [];
  const unpinned: Feature[] = [];
  for (const feature of activeFeatures) {
    (feature.is_pinned ? pinnedFeatures : unpinned).push(feature);
  }

  // First pass: count unpinned features per non-main worktree path so we know
  // which paths qualify as groups (>= 2 features).
  const counts = new Map<string, number>();
  for (const f of unpinned) {
    const wt = worktreeByFeatureId.get(f.id);
    if (wt && wt.worktree_path !== projectPath) {
      counts.set(wt.worktree_path, (counts.get(wt.worktree_path) ?? 0) + 1);
    }
  }

  // Second pass: place each feature in the flat list or its group bucket.
  const flatActiveFeatures: Feature[] = [];
  const worktreeGroups: WorktreeFeatureGroup[] = [];
  const groupByPath = new Map<string, Feature[]>();
  for (const f of unpinned) {
    const wt = worktreeByFeatureId.get(f.id);
    const path = wt?.worktree_path;
    if (!wt || path === projectPath || (counts.get(path!) ?? 0) < 2) {
      flatActiveFeatures.push(f);
      continue;
    }
    let features = groupByPath.get(path!);
    if (!features) {
      features = [];
      groupByPath.set(path!, features);
      worktreeGroups.push({
        key: path!,
        label: wt.worktree_branch ?? (getFileName(path!) || path!),
        features,
      });
    }
    features.push(f);
  }

  return { pinnedFeatures, worktreeGroups, flatActiveFeatures };
}
