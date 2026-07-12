import { describe, expect, it } from "vitest";
import type { Feature } from "@/api/generated";
import { buildFeatureForest } from "./feature-hierarchy";

function feature(id: number, parent?: number): Feature {
  return {
    id,
    project_id: 1,
    title: `Feature ${id}`,
    status: "active",
    type: "ws-session",
    created_at: "2026-01-01",
    is_pinned: false,
    spawned_by_feature_id: parent,
  };
}

describe("feature hierarchy", () => {
  it("keeps input order while nesting linked descendants", () => {
    const forest = buildFeatureForest([feature(1), feature(2, 1), feature(3, 2), feature(4)]);
    expect(forest.map((node) => node.feature.id)).toEqual([1, 4]);
    expect(forest[0]!.children.map((node) => node.feature.id)).toEqual([2]);
    expect(forest[0]!.children[0]!.children.map((node) => node.feature.id)).toEqual([3]);
  });

  it("leaves an orphan flat for backward compatibility", () => {
    expect(buildFeatureForest([feature(2, 99)])[0]?.feature.id).toBe(2);
  });

  it("keeps self-links and ancestry cycles visible as flat roots", () => {
    const forest = buildFeatureForest([feature(1, 1), feature(2, 3), feature(3, 2), feature(4, 2)]);

    expect(forest.map((node) => node.feature.id)).toEqual([1, 2, 3, 4]);
    expect(forest.every((node) => node.children.length === 0)).toBe(true);
  });
});
