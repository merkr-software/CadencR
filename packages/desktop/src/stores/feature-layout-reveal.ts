import {
  clampAutoShare,
  type FeatureLayoutState,
  type LayoutNode,
  type TabKind,
} from "./feature-layout-schema";
import {
  findPaneContaining,
  getLeaves,
  makeLeaf,
  mapLeaf,
  pluckTab,
  splitLeafAt,
  type SplitPath,
} from "./feature-layout-tree";

/**
 * Auto layout's placement policy, kept pure so every rule is unit-testable.
 *
 * Revealing a tab must never hide the agent conversation:
 *  - already visible            → nothing to do (focus may still move)
 *  - in a pane without the agent → activate it there
 *  - sharing the agent's pane    → move it into the last secondary pane, or,
 *                                  with no secondary pane, split it off beside
 *                                  the agent
 * When there is no room to split (`placement: null`) the reveal is `blocked`
 * rather than falling back to hiding the agent — the caller decides.
 */

export type RevealPlacement = "right" | "bottom";

export const DEFAULT_AUTO_SHARE = 40;

export interface RevealOptions {
  /** Edge a new split opens on, or null when the shell is too small to split. */
  placement: RevealPlacement | null;
  /** Move `focusedPaneId` (hotkey routing) to the revealed pane. */
  focus: boolean;
}

export type RevealResult =
  | { kind: "noop" }
  | { kind: "blocked" }
  | { kind: "activated" | "moved" | "split"; state: FeatureLayoutState; paneId: string };

export function planReveal(
  state: FeatureLayoutState,
  tab: TabKind,
  options: RevealOptions,
): RevealResult {
  const host = findPaneContaining(state.splitRoot, tab);
  const agentPane = findPaneContaining(state.splitRoot, "agent");
  if (!host || tab === "agent") return { kind: "noop" };

  if (host.activeTabId === tab) {
    if (!options.focus || state.focusedPaneId === host.id) return { kind: "noop" };
    return { kind: "activated", state: { ...state, focusedPaneId: host.id }, paneId: host.id };
  }

  if (host.id !== agentPane?.id) {
    const splitRoot = mapLeaf(state.splitRoot, host.id, (leaf) => ({ ...leaf, activeTabId: tab }));
    return {
      kind: "activated",
      state: withFocus(state, splitRoot, host.id, options.focus),
      paneId: host.id,
    };
  }

  const plucked = pluckTab(state.splitRoot, tab);
  const secondary = getLeaves(plucked).filter((leaf) => leaf.id !== agentPane.id);
  const target = secondary.at(-1);
  if (target) {
    const splitRoot = mapLeaf(plucked, target.id, (leaf) => ({
      ...leaf,
      tabIds: [...leaf.tabIds, tab],
      activeTabId: tab,
    }));
    return {
      kind: "moved",
      state: withFocus(state, splitRoot, target.id, options.focus),
      paneId: target.id,
    };
  }

  if (options.placement === null) return { kind: "blocked" };
  const newLeaf = makeLeaf([tab], tab);
  const share = state.autoShares?.[tab] ?? DEFAULT_AUTO_SHARE;
  const splitRoot = splitLeafAt(plucked, agentPane.id, options.placement, newLeaf, share);
  return {
    kind: "split",
    state: withFocus(state, splitRoot, newLeaf.id, options.focus),
    paneId: newLeaf.id,
  };
}

function withFocus(
  state: FeatureLayoutState,
  splitRoot: LayoutNode,
  paneId: string,
  focus: boolean,
): FeatureLayoutState {
  return { ...state, splitRoot, focusedPaneId: focus ? paneId : state.focusedPaneId };
}

/**
 * After the user resizes the split at `path`, remember the share of a
 * secondary pane sitting directly beside the agent's pane so the next auto
 * split for its tabs opens at the size the user prefers.
 */
export function rememberAutoShares(state: FeatureLayoutState, path: SplitPath): FeatureLayoutState {
  let node: LayoutNode = state.splitRoot;
  for (const index of path) {
    if (node.type !== "split") return state;
    node = node.children[index];
  }
  if (node.type !== "split" || !node.sizes) return state;
  const agentSide = node.children.findIndex((child) => findPaneContaining(child, "agent"));
  if (agentSide === -1) return state;
  const other = node.children[agentSide === 0 ? 1 : 0];
  if (other.type !== "leaf" || other.tabIds.length === 0) return state;

  const share = clampAutoShare(node.sizes[agentSide === 0 ? 1 : 0]);
  const autoShares = { ...state.autoShares };
  for (const tab of other.tabIds) autoShares[tab] = share;
  return { ...state, autoShares };
}

/** Narrowest shell that still fits the agent and a pane side by side. */
const MIN_WIDTH_FOR_RIGHT_SPLIT = 720;
/** Smallest shell that fits the agent above a pane. */
const MIN_SIZE_FOR_BOTTOM_SPLIT = { width: 480, height: 560 };

/**
 * Edge a new auto split should open on for a shell of this size, or null when
 * it's too small — or unmeasurable, i.e. not on screen.
 */
export function choosePlacement(
  size: { width: number; height: number } | null,
): RevealPlacement | null {
  if (size === null) return null;
  if (size.width >= MIN_WIDTH_FOR_RIGHT_SPLIT) return "right";
  if (
    size.width >= MIN_SIZE_FOR_BOTTOM_SPLIT.width &&
    size.height >= MIN_SIZE_FOR_BOTTOM_SPLIT.height
  ) {
    return "bottom";
  }
  return null;
}
