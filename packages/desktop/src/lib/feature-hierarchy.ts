import type { Feature } from "@/api/generated";

export interface FeatureTreeNode {
  feature: Feature;
  children: FeatureTreeNode[];
}

export function buildFeatureForest(features: readonly Feature[]): FeatureTreeNode[] {
  const nodes = new Map<number, FeatureTreeNode>(
    features.map((feature) => [feature.id, { feature, children: [] }]),
  );
  const roots: FeatureTreeNode[] = [];
  for (const feature of features) {
    const node = nodes.get(feature.id);
    if (!node) continue;
    const parent = feature.spawned_by_feature_id
      ? nodes.get(feature.spawned_by_feature_id)
      : undefined;
    if (parent && !hasAncestryCycle(feature, nodes)) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function hasAncestryCycle(feature: Feature, nodes: ReadonlyMap<number, FeatureTreeNode>): boolean {
  const visited = new Set([feature.id]);
  let parentId = feature.spawned_by_feature_id;
  while (parentId != null) {
    if (visited.has(parentId)) return true;
    visited.add(parentId);
    parentId = nodes.get(parentId)?.feature.spawned_by_feature_id;
  }
  return false;
}

const descendantIdsCache = new WeakMap<FeatureTreeNode, readonly number[]>();

/**
 * Ids of every conversation below `node`, depth first. Cached per node so a
 * collapsed parent hands its row the same array on every render (rows are
 * memoized); a rebuilt forest brings new nodes and a fresh list.
 */
export function descendantIdsOf(node: FeatureTreeNode): readonly number[] {
  const cached = descendantIdsCache.get(node);
  if (cached) return cached;
  const ids: number[] = [];
  const visit = (current: FeatureTreeNode): void => {
    for (const child of current.children) {
      ids.push(child.feature.id);
      visit(child);
    }
  };
  visit(node);
  descendantIdsCache.set(node, ids);
  return ids;
}
