import {
  filterLayoutTabs,
  isPluginTabKind,
  ROOT_LEAF_ID,
  type FeatureLayoutState,
  type LayoutLeaf,
  type LayoutNode,
  type LayoutSplit,
  type PluginTabKind,
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

/** `focusedPaneId` when that leaf still exists in `root`, otherwise `fallback`. */
export function survivingFocus<F extends string | null>(
  root: LayoutNode,
  focusedPaneId: string | null,
  fallback: F,
): string | F {
  return focusedPaneId !== null && findLeafById(root, focusedPaneId) ? focusedPaneId : fallback;
}

/** `state` with a new tree, focusing `paneId` only when `focus` is set. */
export function withFocus(
  state: FeatureLayoutState,
  splitRoot: LayoutNode,
  paneId: string,
  focus: boolean,
): FeatureLayoutState {
  return { ...state, splitRoot, focusedPaneId: focus ? paneId : state.focusedPaneId };
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
  // A tree always holds the root leaf, so the filter never collapses it all.
  return filterLayoutTabs(root, (t) => t !== tab) ?? root;
}

/**
 * The child of `split` that pops (see `LayoutLeaf.pop`): a flagged non-root
 * leaf — the first one if a payload flags both.
 */
export function popChildIndex(split: LayoutSplit): 0 | 1 | null {
  const index = split.children.findIndex(
    (child) => child.type === "leaf" && child.pop === true && child.id !== ROOT_LEAF_ID,
  );
  return index === -1 ? null : (index as 0 | 1);
}

/** Whether `leafId` is a pop pane in effect (flagged, and the side of its split that pops). */
export function isPopLeaf(node: LayoutNode, leafId: string): boolean {
  if (node.type === "leaf") return false;
  const index = popChildIndex(node);
  if (
    index !== null &&
    node.children[index].type === "leaf" &&
    node.children[index].id === leafId
  ) {
    return true;
  }
  return isPopLeaf(node.children[0], leafId) || isPopLeaf(node.children[1], leafId);
}

/**
 * Flag or unflag `leafId` as a pop pane. Flagging clears its sibling leaf's
 * flag: a split keeps one side open. The root leaf never pops.
 */
export function setLeafPop(node: LayoutNode, leafId: string, pop: boolean): LayoutNode {
  if (leafId === ROOT_LEAF_ID) return node;
  if (!pop) return mapLeaf(node, leafId, (leaf) => withPopFlag(leaf, false));
  if (node.type === "leaf") return node.id === leafId ? withPopFlag(node, true) : node;
  const [a, b] = node.children;
  const isChild = (child: LayoutNode): boolean => child.type === "leaf" && child.id === leafId;
  if (isChild(a) || isChild(b)) {
    const newA = a.type === "leaf" ? withPopFlag(a, a.id === leafId) : a;
    const newB = b.type === "leaf" ? withPopFlag(b, b.id === leafId) : b;
    return newA === a && newB === b ? node : { ...node, children: [newA, newB] };
  }
  const newA = setLeafPop(a, leafId, true);
  if (newA !== a) return { ...node, children: [newA, b] };
  const newB = setLeafPop(b, leafId, true);
  return newB === b ? node : { ...node, children: [a, newB] };
}

function withPopFlag(leaf: LayoutLeaf, pop: boolean): LayoutLeaf {
  if ((leaf.pop === true) === pop) return leaf;
  if (pop) return { ...leaf, pop: true };
  const next = { ...leaf };
  delete next.pop;
  return next;
}

export function getFirstLeafId(node: LayoutNode): string {
  return node.type === "leaf" ? node.id : getFirstLeafId(node.children[0]);
}

/** Plugin tabs placed anywhere in the tree, in tree order. */
export function getPluginTabs(node: LayoutNode): PluginTabKind[] {
  return getLeaves(node).flatMap((leaf) => leaf.tabIds.filter(isPluginTabKind));
}

/**
 * View of `state` limited to the tabs that can render right now — a layout
 * keeps the placement of a plugin tab whose plugin is disabled or uninstalled
 * so re-enabling it restores the tab where it was. Unavailable tabs vanish,
 * active tabs fall back to the leaf's first remaining tab and emptied non-root
 * leaves collapse. Returns `state` itself when nothing is hidden: renderers
 * memoize on it (see the #185 notes in `FeatureLayoutShell`/`TabContentRegistry`).
 * Never write the result back to the store; resize a split of the view through
 * `storedSplitPath`, since a collapsed pane shifts the paths below it.
 */
export function restrictLayoutToTabs(
  state: FeatureLayoutState,
  availableTabIds: ReadonlySet<string>,
): FeatureLayoutState {
  const splitRoot = restrictNode(state.splitRoot, (tab) => availableTabIds.has(tab), []);
  if (splitRoot === null || splitRoot === state.splitRoot) return state;
  return {
    ...state,
    splitRoot,
    focusedPaneId: survivingFocus(splitRoot, state.focusedPaneId, null),
  };
}

/** Where each split of the latest views sits in the stored layout. */
const storedPaths = new WeakMap<LayoutSplit, SplitPath>();

/**
 * The path in the stored layout of `split`, a node of a
 * `restrictLayoutToTabs` view rendered at `viewPath`. Store mutations must use
 * it: once a hidden pane collapses, a view path addresses another split.
 */
export function storedSplitPath(split: LayoutSplit, viewPath: SplitPath): SplitPath {
  return storedPaths.get(split) ?? viewPath;
}

/**
 * `filterLayoutTabs` that also records every surviving split's stored path —
 * for all of them, so a split that moved since an earlier view is never read
 * at its old path.
 */
function restrictNode(
  node: LayoutNode,
  keep: (tab: TabKind) => boolean,
  path: SplitPath,
): LayoutNode | null {
  if (node.type === "leaf") return filterLayoutTabs(node, keep);
  const [a, b] = node.children;
  const newA = restrictNode(a, keep, [...path, 0]);
  const newB = restrictNode(b, keep, [...path, 1]);
  if (newA === null) return newB;
  if (newB === null) return newA;
  const split: LayoutSplit = newA === a && newB === b ? node : { ...node, children: [newA, newB] };
  storedPaths.set(split, path);
  return split;
}
