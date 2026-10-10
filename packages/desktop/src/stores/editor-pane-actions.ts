import type { EditorLeaf, EditorSet, EditorStore } from "./editor-store-types";
import { defaultPaneState, nextPaneId, updateFeature } from "./editor-helpers";
import { findAdjacentEditorLeaf, getEditorLeaves, removeLeaf, splitLeaf } from "./editor-tree";

type EditorPaneActions = Pick<
  EditorStore,
  | "toggleSidebar"
  | "hideSidebarBesideAgent"
  | "splitEditorPane"
  | "removeEditorPane"
  | "navigatePane"
  | "setActivePane"
>;

export function createEditorPaneActions(set: EditorSet): EditorPaneActions {
  return {
    toggleSidebar: (featureId) =>
      set((state) => {
        const feature = state.features[featureId];
        if (!feature) return state;
        return updateFeature(state, featureId, {
          ...feature,
          sidebarVisible: !feature.sidebarVisible,
          sidebarAutoHidden: false,
        });
      }),

    hideSidebarBesideAgent: (featureId) =>
      set((state) => {
        const feature = state.features[featureId];
        if (!feature?.sidebarVisible) return state;
        return updateFeature(state, featureId, {
          ...feature,
          sidebarVisible: false,
          sidebarAutoHidden: true,
        });
      }),

    splitEditorPane: (featureId, paneId, orientation) =>
      set((state) => {
        const feature = state.features[featureId];
        if (!feature) return state;
        const newLeaf: EditorLeaf = { type: "leaf", id: nextPaneId() };
        const newTree = splitLeaf(feature.splitTree, paneId, orientation, newLeaf);
        const newPanes = { ...feature.panes, [newLeaf.id]: { ...defaultPaneState } };
        return updateFeature(state, featureId, {
          ...feature,
          splitTree: newTree,
          panes: newPanes,
          activePaneId: newLeaf.id,
        });
      }),

    removeEditorPane: (featureId, paneId) =>
      set((state) => {
        const feature = state.features[featureId];
        if (!feature) return state;

        // Don't remove the last pane
        const leaves = getEditorLeaves(feature.splitTree);
        if (leaves.length <= 1) return state;

        const newTree = removeLeaf(feature.splitTree, paneId);
        if (!newTree) return state;

        // Clean up pane state
        const newPanes = { ...feature.panes };
        delete newPanes[paneId];

        // If active pane was removed, pick the first remaining leaf
        let newActivePaneId = feature.activePaneId;
        if (newActivePaneId === paneId) {
          newActivePaneId = getEditorLeaves(newTree)[0]?.id ?? feature.activePaneId;
        }

        return updateFeature(state, featureId, {
          ...feature,
          splitTree: newTree,
          panes: newPanes,
          activePaneId: newActivePaneId,
        });
      }),

    navigatePane: (featureId, direction) =>
      set((state) => {
        const feature = state.features[featureId];
        if (!feature) return state;
        const adjacent = findAdjacentEditorLeaf(feature.splitTree, feature.activePaneId, direction);
        if (!adjacent) return state;
        return updateFeature(state, featureId, { ...feature, activePaneId: adjacent });
      }),

    setActivePane: (featureId, paneId) =>
      set((state) => {
        const feature = state.features[featureId];
        if (!feature) return state;
        return updateFeature(state, featureId, { ...feature, activePaneId: paneId });
      }),
  };
}
