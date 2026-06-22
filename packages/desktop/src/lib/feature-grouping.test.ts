import { describe, expect, it } from "vitest";
import type { Feature, FeatureWorktreeInfo } from "@/api/generated";
import { partitionActiveFeatures } from "@/lib/feature-grouping";

const PROJECT_PATH = "/repo";

function feature(id: number, overrides: Partial<Feature> = {}): Feature {
  return {
    id,
    project_id: 1,
    title: `Feature ${id}`,
    status: "active",
    type: "ws-session",
    label: null,
    model_session: null,
    created_at: "2026-01-01T00:00:00Z",
    is_pinned: false,
    ...overrides,
  };
}

function worktree(featureId: number, path: string, branch?: string): FeatureWorktreeInfo {
  return {
    feature_id: featureId,
    worktree_path: path,
    worktree_branch: branch ?? null,
    live: true,
  } as FeatureWorktreeInfo;
}

describe("partitionActiveFeatures", () => {
  it("pulls pinned features into their own section, preserving order", () => {
    const features = [feature(1, { is_pinned: true }), feature(2), feature(3, { is_pinned: true })];
    const { pinnedFeatures, flatActiveFeatures, worktreeGroups } = partitionActiveFeatures(
      features,
      new Map(),
      PROJECT_PATH,
    );
    expect(pinnedFeatures.map((f) => f.id)).toEqual([1, 3]);
    expect(flatActiveFeatures.map((f) => f.id)).toEqual([2]);
    expect(worktreeGroups).toHaveLength(0);
  });

  it("never duplicates a pinned feature into a worktree group", () => {
    // Two features share a non-main worktree path, but one is pinned. A group
    // needs >= 2 *unpinned* features, so the remaining single feature stays flat.
    const features = [feature(1, { is_pinned: true }), feature(2)];
    const worktrees = new Map<number, FeatureWorktreeInfo>([
      [1, worktree(1, "/repo/wt", "feat")],
      [2, worktree(2, "/repo/wt", "feat")],
    ]);
    const { pinnedFeatures, worktreeGroups, flatActiveFeatures } = partitionActiveFeatures(
      features,
      worktrees,
      PROJECT_PATH,
    );
    expect(pinnedFeatures.map((f) => f.id)).toEqual([1]);
    expect(worktreeGroups).toHaveLength(0);
    expect(flatActiveFeatures.map((f) => f.id)).toEqual([2]);
  });

  it("groups unpinned features sharing a non-main worktree path", () => {
    const features = [feature(1), feature(2), feature(3)];
    const worktrees = new Map<number, FeatureWorktreeInfo>([
      [1, worktree(1, "/repo/wt", "feat")],
      [2, worktree(2, "/repo/wt", "feat")],
    ]);
    const { worktreeGroups, flatActiveFeatures } = partitionActiveFeatures(
      features,
      worktrees,
      PROJECT_PATH,
    );
    expect(worktreeGroups).toHaveLength(1);
    expect(worktreeGroups[0].label).toBe("feat");
    expect(worktreeGroups[0].features.map((f) => f.id)).toEqual([1, 2]);
    expect(flatActiveFeatures.map((f) => f.id)).toEqual([3]);
  });
});
