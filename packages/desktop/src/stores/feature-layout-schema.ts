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

import { PLUGIN_TAB_ID_PATTERN } from "@/shared/plugin-tab-host";

/**
 * The six first-party tabs every feature page always carries. A layout saved
 * while the custom actions had a `runs` tab drops it on parse (see `parseLeaf`).
 */
export type BuiltinTabKind = "agent" | "terminal" | "git" | "editor" | "browser" | "preview";
/**
 * A custom (plugin) tab, `plugin:<id>`. The id follows the manifest rule in
 * docs/CUSTOM_TABS.md §3 — see `isPluginTabKind`. A layout may hold plugin tabs
 * whose plugin is currently unavailable; the shell hides them from view (see
 * `restrictLayoutToTabs`) without dropping their placement.
 */
export type PluginTabKind = `plugin:${string}`;
export type TabKind = BuiltinTabKind | PluginTabKind;

/** Built-in tabs in their canonical (flat layout) order. */
export const BUILTIN_TAB_KINDS: readonly BuiltinTabKind[] = Object.freeze([
  "agent",
  "terminal",
  "git",
  "editor",
  "browser",
  "preview",
] as const);

const PLUGIN_TAB_PREFIX = "plugin:";

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

/**
 * The default single-pane layout: every built-in tab in one root leaf, then
 * any `pluginTabs` (callers flattening an existing layout pass its plugin tabs
 * so they survive the substitution).
 */
export function flatLayoutState(
  activeTabId: TabKind = "agent",
  pluginTabs: readonly PluginTabKind[] = [],
): FeatureLayoutState {
  return {
    version: 1,
    splitRoot: {
      type: "leaf",
      id: ROOT_LEAF_ID,
      tabIds: [...BUILTIN_TAB_KINDS, ...pluginTabs],
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
    tabIds: Object.freeze([...BUILTIN_TAB_KINDS]) as TabKind[],
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

export function isBuiltinTabKind(value: unknown): value is BuiltinTabKind {
  return typeof value === "string" && BUILTIN_TAB_KINDS.includes(value as BuiltinTabKind);
}

/** `plugin:<id>` with an id that is a valid manifest id (a URL host label). */
export function isPluginTabKind(value: unknown): value is PluginTabKind {
  return (
    typeof value === "string" &&
    value.startsWith(PLUGIN_TAB_PREFIX) &&
    PLUGIN_TAB_ID_PATTERN.test(value.slice(PLUGIN_TAB_PREFIX.length))
  );
}

export function isTabKind(value: unknown): value is TabKind {
  return isBuiltinTabKind(value) || isPluginTabKind(value);
}

/** The tab kind of a plugin. Throws on an id the manifest rules would reject. */
export function pluginTabKind(pluginId: string): PluginTabKind {
  const tab = `${PLUGIN_TAB_PREFIX}${pluginId}` as const;
  if (!isPluginTabKind(tab)) throw new Error(`Invalid plugin tab id: ${JSON.stringify(pluginId)}`);
  return tab;
}

/** The plugin id behind a plugin tab, or `null` for a built-in tab. */
export function pluginIdOfTab(tab: TabKind): string | null {
  return isPluginTabKind(tab) ? tab.slice(PLUGIN_TAB_PREFIX.length) : null;
}

/**
 * Keep only the tabs `keep` accepts, preserving structure wherever nothing
 * changes (same node identity back). A leaf whose active tab went away falls
 * back to its first remaining tab; a non-root leaf left empty collapses into
 * its sibling. Returns `null` only when the whole subtree collapsed, which
 * cannot happen for a tree containing the root leaf. `keep` is called once per
 * tab in tree order (depth-first, first child first), so it may be stateful.
 */
export function filterLayoutTabs(
  node: LayoutNode,
  keep: (tab: TabKind) => boolean,
): LayoutNode | null {
  if (node.type === "leaf") {
    const tabIds = node.tabIds.filter((tab) => keep(tab));
    const activeTabId =
      node.activeTabId !== null && !tabIds.includes(node.activeTabId)
        ? (tabIds[0] ?? null)
        : node.activeTabId;
    if (tabIds.length === 0 && node.id !== ROOT_LEAF_ID) return null;
    if (tabIds.length === node.tabIds.length && activeTabId === node.activeTabId) return node;
    return { ...node, tabIds, activeTabId };
  }
  const [a, b] = node.children;
  const newA = filterLayoutTabs(a, keep);
  const newB = filterLayoutTabs(b, keep);
  if (newA === null) return newB;
  if (newB === null) return newA;
  if (newA === a && newB === b) return node;
  return { ...node, children: [newA, newB] };
}

/**
 * Lenient on tab ids, strict on structure: an unknown or invalid tab id (a
 * removed plugin, a future built-in) is dropped rather than rejecting the
 * whole saved layout. Dedupe and empty-leaf collapse happen in
 * `parseLayoutState` once the whole tree is known.
 */
function parseLeaf(value: Record<string, unknown>): LayoutLeaf | null {
  if (typeof value.id !== "string" || value.id.length === 0) return null;
  if (!Array.isArray(value.tabIds)) return null;
  const tabIds = value.tabIds.filter(isTabKind);
  const activeTabId =
    value.activeTabId === null
      ? null
      : isTabKind(value.activeTabId)
        ? value.activeTabId
        : (tabIds[0] ?? null);
  return { type: "leaf", id: value.id, tabIds, activeTabId };
}

function parseLayoutNode(value: unknown): LayoutNode | null {
  if (!isObject(value)) return null;
  if (value.type === "leaf") return parseLeaf(value);
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
    const activeTabId = node.activeTabId ?? tabs[0];
    return { ...node, tabIds: [...node.tabIds, ...tabs], activeTabId };
  }
  const [a, b] = node.children;
  const newA = appendTabsToRoot(a, tabs);
  if (newA !== a) return { ...node, children: [newA, b] };
  const newB = appendTabsToRoot(b, tabs);
  return newB === b ? node : { ...node, children: [a, newB] };
}

/** Append the built-ins a payload lacks to the root leaf (plugin tabs are never added). */
function normalizeLayoutNode(node: LayoutNode): LayoutNode {
  const presentTabs = new Set<TabKind>();
  collectTabs(node, presentTabs);
  const missingTabs = BUILTIN_TAB_KINDS.filter((tab) => !presentTabs.has(tab));
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

  const parsedRoot = parseLayoutNode(value.splitRoot);
  if (parsedRoot === null) return null;
  if (!containsLeaf(parsedRoot, ROOT_LEAF_ID)) return null;
  // A tab lives in exactly one leaf: keep the first occurrence in tree order.
  const seen = new Set<TabKind>();
  const splitRoot = filterLayoutTabs(parsedRoot, (tab) => {
    if (seen.has(tab)) return false;
    seen.add(tab);
    return true;
  });
  if (splitRoot === null) return null;

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
