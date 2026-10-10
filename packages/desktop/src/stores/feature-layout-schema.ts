/**
 * Runtime types + parser for the feature-page splittable layout. The same
 * shape is serialized to:
 *   - `feature_settings.layout_state` (per-feature current state)
 *   - `feature_layouts.config` (named saved layouts)
 *
 * Backend treats both as opaque JSON; this module is the single source of
 * truth for shape validation. We hand-roll the narrowing instead of pulling
 * in zod — zod isn't a project dep yet and the schema is small enough that a
 * plain validator stays readable.
 *
 * # Tree model
 *
 * A feature's content area is a binary tree of panes. Each leaf hosts a list
 * of tab kinds and tracks which one is currently active. There is always
 * exactly one leaf with id `ROOT_LEAF_ID` ("root") — the user-facing tab bar
 * at the top of the page is rendered from that leaf's strip. The root leaf
 * can never be removed (it can sit empty); all other leaves auto-collapse
 * when their last tab is pulled out.
 */

export type TabKind = "agent" | "terminal" | "git" | "editor" | "browser";
export const ALL_TAB_KINDS: readonly TabKind[] = [
  "agent",
  "terminal",
  "git",
  "editor",
  "browser",
] as const;

export const ROOT_LEAF_ID = "root";
export const LAYOUT_STATE_KEY = "layout_state";

export type SplitOrientation = "horizontal" | "vertical";

export interface LayoutLeaf {
  type: "leaf";
  id: string;
  tabIds: TabKind[];
  activeTabId: TabKind | null;
}

export interface LayoutSplit {
  type: "split";
  orientation: SplitOrientation;
  /** [first, second] children, ordered top→bottom (vertical) or left→right (horizontal). */
  children: [LayoutNode, LayoutNode];
  /** Optional persisted sizes (percentages, sum 100), threaded through to react-resizable-panels. */
  sizes?: [number, number];
}

export type LayoutNode = LayoutLeaf | LayoutSplit;

export interface FeatureLayoutState {
  /** Schema version. Bump when layout shape changes; old payloads fall back to flat. */
  version: 1;
  /** Always non-null. Always contains a leaf with id `ROOT_LEAF_ID`. */
  splitRoot: LayoutNode;
  /**
   * Pane id whose strip last received focus. Used by hotkeys to send focus to
   * the right pane when activating a tab.
   */
  focusedPaneId: string | null;
  /** Id of the saved layout currently applied (for the "Update X" menu item). */
  appliedLayoutId: number | null;
  /**
   * Auto layout's size memory: the share (percent) the user last gave a pane
   * holding this tab when it sat beside the agent. Seeds the next split auto
   * layout opens for that tab. Per-feature only — never part of a saved layout.
   */
  autoShares?: AutoShares;
}

export type AutoShares = Partial<Record<TabKind, number>>;

/** Bounds a remembered auto-layout share is clamped to, in percent. */
const MIN_AUTO_SHARE = 20;
const MAX_AUTO_SHARE = 80;

export function clampAutoShare(share: number): number {
  return Math.round(Math.min(MAX_AUTO_SHARE, Math.max(MIN_AUTO_SHARE, share)));
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** The default single-pane layout: every tab in one root leaf. */
export function flatLayoutState(activeTabId: TabKind = "agent"): FeatureLayoutState {
  return {
    version: 1,
    splitRoot: {
      type: "leaf",
      id: ROOT_LEAF_ID,
      tabIds: [...ALL_TAB_KINDS],
      activeTabId,
    },
    focusedPaneId: ROOT_LEAF_ID,
    appliedLayoutId: null,
  };
}

/**
 * Stable, frozen sentinel used as the *read-only* fallback by selectors before
 * a feature has been hydrated. **Never** pass this into the store (mutations
 * are produced via structural updates that would attempt to spread it). It
 * exists purely so selectors return a referentially stable value during the
 * initial render — otherwise Zustand sees a fresh `flatLayoutState()` on every
 * call and triggers an infinite re-render loop.
 */
export const EMPTY_LAYOUT_STATE: FeatureLayoutState = Object.freeze({
  version: 1,
  splitRoot: Object.freeze({
    type: "leaf",
    id: ROOT_LEAF_ID,
    tabIds: Object.freeze([...ALL_TAB_KINDS]) as TabKind[],
    activeTabId: "agent",
  }) as LayoutLeaf,
  focusedPaneId: ROOT_LEAF_ID,
  appliedLayoutId: null,
}) as FeatureLayoutState;

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isTabKind(value: unknown): value is TabKind {
  return typeof value === "string" && ALL_TAB_KINDS.includes(value as TabKind);
}

function parseTabKindArray(value: unknown): TabKind[] | null {
  if (!Array.isArray(value)) return null;
  const out: TabKind[] = [];
  for (const item of value) {
    if (!isTabKind(item)) return null;
    out.push(item);
  }
  return out;
}

function parseLayoutNode(value: unknown): LayoutNode | null {
  if (!isObject(value)) return null;
  if (value.type === "leaf") {
    if (typeof value.id !== "string" || value.id.length === 0) return null;
    const tabIds = parseTabKindArray(value.tabIds);
    if (tabIds === null) return null;
    const activeTabId =
      value.activeTabId === null
        ? null
        : isTabKind(value.activeTabId)
          ? value.activeTabId
          : undefined;
    if (activeTabId === undefined) return null;
    return { type: "leaf", id: value.id, tabIds, activeTabId };
  }
  if (value.type === "split") {
    if (value.orientation !== "horizontal" && value.orientation !== "vertical") return null;
    if (!Array.isArray(value.children) || value.children.length !== 2) return null;
    const a = parseLayoutNode(value.children[0]);
    const b = parseLayoutNode(value.children[1]);
    if (a === null || b === null) return null;
    let sizes: [number, number] | undefined;
    if (value.sizes !== undefined) {
      if (
        !Array.isArray(value.sizes) ||
        value.sizes.length !== 2 ||
        typeof value.sizes[0] !== "number" ||
        typeof value.sizes[1] !== "number"
      ) {
        return null;
      }
      sizes = [value.sizes[0], value.sizes[1]];
    }
    const split: LayoutSplit = { type: "split", orientation: value.orientation, children: [a, b] };
    return sizes ? { ...split, sizes } : split;
  }
  return null;
}

function containsRootLeaf(node: LayoutNode): boolean {
  return containsLeaf(node, ROOT_LEAF_ID);
}

function containsLeaf(node: LayoutNode, leafId: string): boolean {
  if (node.type === "leaf") return node.id === leafId;
  return containsLeaf(node.children[0], leafId) || containsLeaf(node.children[1], leafId);
}

function collectTabs(node: LayoutNode, out: Set<TabKind>): void {
  if (node.type === "leaf") {
    for (const tab of node.tabIds) out.add(tab);
    return;
  }
  collectTabs(node.children[0], out);
  collectTabs(node.children[1], out);
}

function appendTabsToRoot(node: LayoutNode, tabs: readonly TabKind[]): LayoutNode {
  if (tabs.length === 0) return node;
  if (node.type === "leaf") {
    if (node.id !== ROOT_LEAF_ID) return node;
    return { ...node, tabIds: [...node.tabIds, ...tabs] };
  }
  const [a, b] = node.children;
  const newA = appendTabsToRoot(a, tabs);
  if (newA !== a) return { ...node, children: [newA, b] };
  const newB = appendTabsToRoot(b, tabs);
  return newB === b ? node : { ...node, children: [a, newB] };
}

function normalizeLayoutNode(node: LayoutNode): LayoutNode {
  const presentTabs = new Set<TabKind>();
  collectTabs(node, presentTabs);
  const missingTabs = ALL_TAB_KINDS.filter((tab) => !presentTabs.has(tab));
  return appendTabsToRoot(node, missingTabs);
}

function parseAutoShares(value: unknown): AutoShares | undefined {
  if (!isObject(value)) return undefined;
  const shares: AutoShares = {};
  for (const [tab, share] of Object.entries(value)) {
    if (!isTabKind(tab) || typeof share !== "number" || !Number.isFinite(share)) continue;
    shares[tab] = clampAutoShare(share);
  }
  return Object.keys(shares).length > 0 ? shares : undefined;
}

/**
 * Parse + validate a serialized FeatureLayoutState. Returns `null` when the
 * payload is malformed so callers can fall back to a flat default and surface
 * a toast (we never silently swallow — see `error-handling.md`).
 */
export function parseLayoutState(input: unknown): FeatureLayoutState | null {
  let value: unknown = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!isObject(value)) return null;
  if (value.version !== 1) return null;

  const splitRoot = parseLayoutNode(value.splitRoot);
  if (splitRoot === null) return null;
  if (!containsRootLeaf(splitRoot)) return null;

  const rawFocusedPaneId =
    value.focusedPaneId === null
      ? null
      : typeof value.focusedPaneId === "string"
        ? value.focusedPaneId
        : undefined;
  if (rawFocusedPaneId === undefined) return null;
  const focusedPaneId =
    rawFocusedPaneId !== null && containsLeaf(splitRoot, rawFocusedPaneId)
      ? rawFocusedPaneId
      : null;

  const appliedLayoutId =
    value.appliedLayoutId === null
      ? null
      : typeof value.appliedLayoutId === "number"
        ? value.appliedLayoutId
        : undefined;
  if (appliedLayoutId === undefined) return null;

  const autoShares = parseAutoShares(value.autoShares);
  return {
    version: 1,
    splitRoot: normalizeLayoutNode(splitRoot),
    focusedPaneId,
    appliedLayoutId,
    ...(autoShares ? { autoShares } : {}),
  };
}

export function serializeLayoutState(state: FeatureLayoutState): string {
  return JSON.stringify(state);
}

/** Serialize the per-feature current layout, preserving focus and size memory. */
export function serializeCurrentLayoutState(state: FeatureLayoutState): string {
  return JSON.stringify({
    version: 1,
    splitRoot: state.splitRoot,
    focusedPaneId: state.focusedPaneId,
    appliedLayoutId: null,
    autoShares: state.autoShares,
  });
}

/** Serialize a reusable layout template, without feature-specific focus. */
export function serializeLayoutForSave(state: FeatureLayoutState): string {
  return JSON.stringify({
    version: 1,
    splitRoot: state.splitRoot,
    focusedPaneId: null,
    appliedLayoutId: null,
  });
}
