import {
  ROOT_LEAF_ID,
  type LayoutLeaf,
  type LayoutNode,
  type LayoutSplit,
  type SplitOrientation,
  type TabKind,
} from "./feature-layout-schema";

/**
 * Pure, structurally-shared helpers over the feature layout split tree
 * (mirrors patterns from editor-store.ts). Shared by the store's mutations and
 * the auto-layout reveal planner (`feature-layout-reveal.ts`).
 */

export type SplitEdge = "top" | "right" | "bottom" | "left";
export type SplitPath = ReadonlyArray<0 | 1>;

export function getLeaves(node: LayoutNode): LayoutLeaf[] {
  if (node.type === "leaf") return [node];
  return [...getLeaves(node.children[0]), ...getLeaves(node.children[1])];
}

export function findLeafById(node: LayoutNode, leafId: string): LayoutLeaf | null {
  if (node.type === "leaf") return node.id === leafId ? node : null;
  return findLeafById(node.children[0], leafId) ?? findLeafById(node.children[1], leafId);
}

export function findPaneContaining(node: LayoutNode, tab: TabKind): LayoutLeaf | null {
  if (node.type === "leaf") return node.tabIds.includes(tab) ? node : null;
  return findPaneContaining(node.children[0], tab) ?? findPaneContaining(node.children[1], tab);
}

function edgeToSplit(edge: SplitEdge): { orientation: SplitOrientation; newAtIndex: 0 | 1 } {
  switch (edge) {
    case "top":
      return { orientation: "vertical", newAtIndex: 0 };
    case "bottom":
      return { orientation: "vertical", newAtIndex: 1 };
    case "left":
      return { orientation: "horizontal", newAtIndex: 0 };
    case "right":
      return { orientation: "horizontal", newAtIndex: 1 };
  }
}

/**
 * Split `targetLeafId` along `edge`, placing `newLeaf` on that side. When
 * `newLeafShare` (percent) is given, the new split carries explicit sizes so the
 * new pane opens at that share instead of the 50/50 default.
 */
export function splitLeafAt(
  node: LayoutNode,
  targetLeafId: string,
  edge: SplitEdge,
  newLeaf: LayoutLeaf,
  newLeafShare?: number,
): LayoutNode {
  if (node.type === "leaf") {
    if (node.id !== targetLeafId) return node;
    const { orientation, newAtIndex } = edgeToSplit(edge);
    const children: [LayoutNode, LayoutNode] = newAtIndex === 0 ? [newLeaf, node] : [node, newLeaf];
    const split: LayoutSplit = { type: "split", orientation, children };
    if (newLeafShare === undefined) return split;
    const rest = 100 - newLeafShare;
    return { ...split, sizes: newAtIndex === 0 ? [newLeafShare, rest] : [rest, newLeafShare] };
  }
  const [a, b] = node.children;
  const newA = splitLeafAt(a, targetLeafId, edge, newLeaf, newLeafShare);
  if (newA !== a) return { ...node, children: [newA, b] };
  const newB = splitLeafAt(b, targetLeafId, edge, newLeaf, newLeafShare);
  if (newB !== b) return { ...node, children: [a, newB] };
  return node;
}

/**
 * Remove a leaf by id; collapses parent split when one side empties.
 * The root leaf is *kept* even when empty — caller code must not pass it
 * as a removal target.
 */
export function removeLeafById(node: LayoutNode, leafId: string): LayoutNode {
  if (node.type === "leaf") {
    // We never reach here with the root id (caller guards), but be defensive.
    return node;
  }
  const [a, b] = node.children;
  if (a.type === "leaf" && a.id === leafId) return b;
  if (b.type === "leaf" && b.id === leafId) return a;
  const newA = removeLeafById(a, leafId);
  const newB = removeLeafById(b, leafId);
  if (newA === a && newB === b) return node;
  return { ...node, children: [newA, newB] };
}

export function mapLeaf(
  node: LayoutNode,
  leafId: string,
  fn: (leaf: LayoutLeaf) => LayoutLeaf,
): LayoutNode {
  if (node.type === "leaf") return node.id === leafId ? fn(node) : node;
  const [a, b] = node.children;
  const newA = mapLeaf(a, leafId, fn);
  if (newA !== a) return { ...node, children: [newA, b] };
  const newB = mapLeaf(b, leafId, fn);
  if (newB !== b) return { ...node, children: [a, newB] };
  return node;
}

export function mapSplitsAtPath(
  node: LayoutNode,
  path: SplitPath,
  depth: number,
  fn: (split: LayoutSplit) => LayoutSplit,
): LayoutNode {
  if (node.type === "leaf") return node;
  if (depth === path.length) return fn(node);
  const idx = path[depth];
  const child = node.children[idx];
  const newChild = mapSplitsAtPath(child, path, depth + 1, fn);
  if (newChild === child) return node;
  const newChildren: [LayoutNode, LayoutNode] = [...node.children];
  newChildren[idx] = newChild;
  return { ...node, children: newChildren };
}

export function makeLeaf(tabs: TabKind[], active: TabKind): LayoutLeaf {
  return {
    type: "leaf",
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2),
    tabIds: tabs,
    activeTabId: active,
  };
}

/**
 * Strip a tab from the entire tree. Non-root leaves collapse when empty.
 * The root leaf stays (possibly empty).
 */
export function pluckTab(root: LayoutNode, tab: TabKind): LayoutNode {
  const containing = findPaneContaining(root, tab);
  if (containing === null) return root;
  const remainingTabs = containing.tabIds.filter((t) => t !== tab);
  if (remainingTabs.length === 0 && containing.id !== ROOT_LEAF_ID) {
    return removeLeafById(root, containing.id);
  }
  return mapLeaf(root, containing.id, (leaf) => {
    const nextActive: TabKind | null =
      leaf.activeTabId === tab ? (remainingTabs[0] ?? null) : leaf.activeTabId;
    return { ...leaf, tabIds: remainingTabs, activeTabId: nextActive };
  });
}

export function getFirstLeafId(node: LayoutNode): string {
  return node.type === "leaf" ? node.id : getFirstLeafId(node.children[0]);
}
