import { describe, expect, it } from "vitest";
import type { Feature } from "@/api/generated";
import { buildFeatureForest } from "@/lib/feature-hierarchy";
import {
  childSiblingGroups,
  flattenForestIds,
  indexReorderGroups,
  keyboardMoveTarget,
  moveWithinGroup,
  placeInGroup,
  projectReorderGroups,
  pruneManualOrder,
  sortByManualOrder,
} from "@/lib/sidebar-manual-order";

function feature(id: number, parent?: number): Feature {
  return { id, title: `F${id}`, spawned_by_feature_id: parent ?? null } as unknown as Feature;
}

const ids = (features: readonly Feature[]) => features.map((f) => f.id);

describe("sortByManualOrder", () => {
  it("puts unranked conversations first in their incoming order, then the ranked ones", () => {
    const features = [feature(1), feature(2), feature(3), feature(4)];
    expect(ids(sortByManualOrder(features, [3, 1]))).toEqual([2, 4, 3, 1]);
  });

  it("keeps the list itself without an order", () => {
    const features = [feature(1), feature(2)];
    expect(sortByManualOrder(features, [])).toBe(features);
  });
});

describe("moveWithinGroup", () => {
  it("moves before or after the target", () => {
    expect(moveWithinGroup([1, 2, 3], 3, 1, "before")).toEqual([3, 1, 2]);
    expect(moveWithinGroup([1, 2, 3], 1, 3, "after")).toEqual([2, 3, 1]);
  });

  it("returns null when nothing moves or an id is outside the group", () => {
    expect(moveWithinGroup([1, 2, 3], 1, 2, "before")).toBeNull();
    expect(moveWithinGroup([1, 2, 3], 2, 1, "after")).toBeNull();
    expect(moveWithinGroup([1, 2, 3], 2, 2, "after")).toBeNull();
    expect(moveWithinGroup([1, 2, 3], 9, 1, "before")).toBeNull();
    expect(moveWithinGroup([1, 2, 3], 1, 9, "before")).toBeNull();
  });
});

describe("placeInGroup", () => {
  it("moves a row up and down inside its group", () => {
    expect(placeInGroup([1, 2, 3, 4], [1, 2, 3, 4], 3, 1, "before")).toEqual([3, 1, 2, 4]);
    expect(placeInGroup([1, 2, 3, 4], [1, 2, 3, 4], 1, 3, "after")).toEqual([2, 3, 1, 4]);
  });

  it("leaves the members of other groups in their slots", () => {
    // Group A = 1, 3, 5; group B = 2, 4 interleaved in the rank.
    expect(placeInGroup([1, 2, 3, 4, 5], [1, 3, 5], 5, 1, "before")).toEqual([5, 2, 1, 4, 3]);
  });

  it("ranks unranked members first, in their displayed order", () => {
    // 7 and 8 are new: displayed first, as sortByManualOrder shows them.
    expect(placeInGroup([1, 2], [7, 8, 1, 2], 2, 8, "before")).toEqual([7, 2, 8, 1]);
  });

  it("keeps the slots of members the filter hides", () => {
    // 2 is in the same group but filtered out: only 1, 3 and 4 are displayed.
    expect(placeInGroup([1, 2, 3, 4], [1, 3, 4], 4, 1, "before")).toEqual([4, 2, 1, 3]);
  });

  it("returns the order itself when nothing moves", () => {
    const order = [1, 2, 3];
    expect(placeInGroup(order, [1, 2, 3], 1, 2, "before")).toBe(order);
  });
});

describe("pruneManualOrder", () => {
  it("drops ids no longer listed but keeps the ones just dropped", () => {
    expect(pruneManualOrder([1, 2, 3, 9], new Set([1, 3]), [9])).toEqual([1, 3, 9]);
  });
});

describe("keyboardMoveTarget", () => {
  it("lands next to the neighbor, nowhere at the group's edge", () => {
    expect(keyboardMoveTarget([1, 2, 3], 2, "up")).toEqual({ targetId: 1, position: "before" });
    expect(keyboardMoveTarget([1, 2, 3], 2, "down")).toEqual({ targetId: 3, position: "after" });
    expect(keyboardMoveTarget([1, 2, 3], 1, "up")).toBeNull();
    expect(keyboardMoveTarget([1, 2, 3], 3, "down")).toBeNull();
    expect(keyboardMoveTarget([1, 2, 3], 9, "down")).toBeNull();
  });
});

describe("reorder groups", () => {
  it("indexes each member's group and leaves single rows out", () => {
    const index = indexReorderGroups([[1, 2], [3], [4, 5, 6]]);
    expect(index.get(2)).toEqual([1, 2]);
    expect(index.get(5)).toEqual([4, 5, 6]);
    expect(index.has(3)).toBe(false);
  });

  it("lists each parent's children as one sibling group", () => {
    const forest = buildFeatureForest([
      feature(1),
      feature(2, 1),
      feature(3, 1),
      feature(4, 2),
      feature(5),
    ]);
    expect(childSiblingGroups(forest)).toEqual([[2, 3], [4]]);
  });

  it("groups a project's worktree roots, flat roots, dormant roots and children apart", () => {
    const forest = buildFeatureForest([feature(1), feature(2, 1), feature(3, 1), feature(4)]);
    const groups = projectReorderGroups(
      {
        worktreeGroups: [{ key: "wt", label: "wt", features: [feature(5), feature(6)] }],
        flatActiveFeatures: [feature(1), feature(4)],
      },
      [feature(7)],
      forest,
    );
    expect(groups).toEqual([[5, 6], [1, 4], [7], [2, 3]]);
    expect(flattenForestIds(forest)).toEqual([1, 2, 3, 4]);
  });
});
