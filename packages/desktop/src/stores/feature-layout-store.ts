import { create } from "zustand";

import {
  EMPTY_LAYOUT_STATE,
  flatLayoutState,
  ROOT_LEAF_ID,
  type FeatureLayoutState,
  type LayoutLeaf,
  type LayoutNode,
  type TabKind,
} from "./feature-layout-schema";
import {
  findLeafById,
  findPaneContaining,
  getFirstLeafId,
  getLeaves,
  makeLeaf,
  mapLeaf,
  mapSplitsAtPath,
  pluckTab,
  splitLeafAt,
  type SplitEdge,
  type SplitPath,
} from "./feature-layout-tree";
import { rememberAutoShares } from "./feature-layout-reveal";

export { findLeafById, findPaneContaining, getLeaves, type SplitEdge, type SplitPath };

/**
 * Per-feature layout state, keyed by feature id. Modeled after `editor-store.ts`
 * (binary split tree) but with a *list* of tabs per leaf so multiple tabs can
 * share a pane (VSCode-style).
 *
 * Truth rules:
 *  - `splitRoot` is never null. It always contains a leaf with id ROOT_LEAF_ID.
 *  - A tab lives in exactly one leaf at a time.
 *  - A non-root leaf with empty `tabIds` collapses to its sibling.
 *  - The root leaf may be empty (placeholder strip in the UI).
 */

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface FeatureLayoutStore {
  features: Record<number, FeatureLayoutState>;
  // ---- bootstrap / replace ----
  setState(featureId: number, state: FeatureLayoutState): void;
  resetToFlat(featureId: number): void;
  ensureInitialized(featureId: number): FeatureLayoutState;
  // ---- moves ----
  /** Drag a tab onto a pane edge; creates a new sibling pane next to `targetPaneId`. */
  splitTabAt(featureId: number, tab: TabKind, targetPaneId: string, edge: SplitEdge): void;
  /** Drop a tab into an existing pane (center drop or strip insertion). */
  moveTabToPane(featureId: number, tab: TabKind, targetPaneId: string, index?: number): void;
  /** Convenience: move a tab back to the root pane's strip. */
  dockTab(featureId: number, tab: TabKind, index?: number): void;
  /** Set which tab is shown inside a pane's strip. */
  setPaneActiveTab(featureId: number, paneId: string, tab: TabKind): void;
  // ---- resize ----
  setSplitSizes(featureId: number, splitPath: SplitPath, sizes: [number, number]): void;
  // ---- focus ----
  setFocusedPane(featureId: number, paneId: string | null): void;
  // ---- saved layouts metadata ----
  setAppliedLayoutId(featureId: number, layoutId: number | null): void;
}

function update(
  set: (fn: (s: FeatureLayoutStore) => Partial<FeatureLayoutStore>) => void,
  featureId: number,
  fn: (state: FeatureLayoutState) => FeatureLayoutState,
): void {
  set((s) => {
    const current = s.features[featureId] ?? flatLayoutState();
    const next = fn(current);
    // No-op: the action computed an identical state. Skip the features-map
    // rebuild so consumers subscribed via selectors don't rerender.
    if (next === current) return s;
    return { features: { ...s.features, [featureId]: next } };
  });
}

export const useFeatureLayoutStore = create<FeatureLayoutStore>((set, get) => ({
  features: {},

  setState: (featureId, state) => set((s) => ({ features: { ...s.features, [featureId]: state } })),

  resetToFlat: (featureId) =>
    set((s) => {
      // Resetting is about panes: auto layout's size memory survives it.
      const autoShares = s.features[featureId]?.autoShares;
      return { features: { ...s.features, [featureId]: { ...flatLayoutState(), autoShares } } };
    }),

  ensureInitialized: (featureId) => {
    const existing = get().features[featureId];
    if (existing) return existing;
    const initial = flatLayoutState();
    set((s) => ({ features: { ...s.features, [featureId]: initial } }));
    return initial;
  },

  splitTabAt: (featureId, tab, targetPaneId, edge) =>
    update(set, featureId, (st) => {
      const after = pluckTab(st.splitRoot, tab);
      // Target may have collapsed if it was the source's empty sibling.
      const targetExists = findLeafById(after, targetPaneId) !== null;
      const newLeaf = makeLeaf([tab], tab);
      let splitRoot: LayoutNode;
      if (targetExists) {
        splitRoot = splitLeafAt(after, targetPaneId, edge, newLeaf);
      } else if (after.type === "leaf") {
        splitRoot = splitLeafAt(after, after.id, edge, newLeaf);
      } else {
        // Fall back to splitting the leftmost leaf so the user sees *something*.
        splitRoot = splitLeafAt(after, getFirstLeafId(after), edge, newLeaf);
      }
      return { ...st, splitRoot, focusedPaneId: newLeaf.id };
    }),

  moveTabToPane: (featureId, tab, targetPaneId, index) =>
    update(set, featureId, (st) => {
      const after = pluckTab(st.splitRoot, tab);
      const target = findLeafById(after, targetPaneId);
      if (!target) return st; // target collapsed; bail (caller already handled fallback if needed)
      const splitRoot = mapLeaf(after, targetPaneId, (leaf) => {
        const at = index ?? leaf.tabIds.length;
        const tabIds = [...leaf.tabIds];
        tabIds.splice(at, 0, tab);
        return { ...leaf, tabIds, activeTabId: tab };
      });
      return { ...st, splitRoot, focusedPaneId: targetPaneId };
    }),

  dockTab: (featureId, tab, index) => get().moveTabToPane(featureId, tab, ROOT_LEAF_ID, index),

  setPaneActiveTab: (featureId, paneId, tab) =>
    update(set, featureId, (st) => {
      const splitRoot = mapLeaf(st.splitRoot, paneId, (leaf) =>
        leaf.tabIds.includes(tab) && leaf.activeTabId !== tab
          ? { ...leaf, activeTabId: tab }
          : leaf,
      );
      // Skip the rebuild entirely if neither the active tab nor focus changed.
      if (splitRoot === st.splitRoot && st.focusedPaneId === paneId) return st;
      return { ...st, splitRoot, focusedPaneId: paneId };
    }),

  setSplitSizes: (featureId, splitPath, sizes) =>
    update(set, featureId, (st) => {
      const splitRoot = mapSplitsAtPath(st.splitRoot, splitPath, 0, (split) => ({
        ...split,
        sizes,
      }));
      return rememberAutoShares({ ...st, splitRoot }, splitPath);
    }),

  setFocusedPane: (featureId, paneId) =>
    update(set, featureId, (st) =>
      st.focusedPaneId === paneId ? st : { ...st, focusedPaneId: paneId },
    ),

  setAppliedLayoutId: (featureId, layoutId) =>
    update(set, featureId, (st) => ({ ...st, appliedLayoutId: layoutId })),
}));

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export function selectFeatureLayout(featureId: number) {
  // CAUTION: must return a referentially stable value when the feature isn't
  // hydrated yet — otherwise Zustand sees a new object on every render and
  // triggers an infinite re-render loop in any consumer reading the whole
  // state (or any nested object like `.splitRoot`).
  return (s: FeatureLayoutStore): FeatureLayoutState => s.features[featureId] ?? EMPTY_LAYOUT_STATE;
}

/** Pane id that hosts the given tab, or `null` if the tab isn't placed yet. */
export function findHostFor(state: FeatureLayoutState, tab: TabKind): string | null {
  return findPaneContaining(state.splitRoot, tab)?.id ?? null;
}

export function activateFeatureTab(featureId: number, tab: TabKind): boolean {
  // `selectFeatureLayout` falls back to `EMPTY_LAYOUT_STATE`, so this also
  // works for features whose layout hasn't been hydrated yet (e.g. embedded
  // cards in the unified agent view). `setPaneActiveTab` seeds the entry on
  // first write.
  const state = selectFeatureLayout(featureId)(useFeatureLayoutStore.getState());
  const paneId = findHostFor(state, tab);
  if (!paneId) return false;
  useFeatureLayoutStore.getState().setPaneActiveTab(featureId, paneId, tab);
  return true;
}

/** Pane whose active tab should be treated as globally focused. */
export function getFocusedLeaf(state: FeatureLayoutState): LayoutLeaf | null {
  const focusedLeaf = state.focusedPaneId
    ? findLeafById(state.splitRoot, state.focusedPaneId)
    : null;
  return (
    focusedLeaf ??
    findLeafById(state.splitRoot, ROOT_LEAF_ID) ??
    getLeaves(state.splitRoot)[0] ??
    null
  );
}

/** The single globally focused tab, falling back to the root pane's active tab. */
export function getFocusedTab(state: FeatureLayoutState): TabKind | null {
  return getFocusedLeaf(state)?.activeTabId ?? null;
}

/** Whether the given tab is currently visible (it's the host pane's active tab). */
export function isTabVisible(state: FeatureLayoutState, tab: TabKind): boolean {
  const leaf = findPaneContaining(state.splitRoot, tab);
  return leaf?.activeTabId === tab;
}
