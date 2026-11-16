import {
  BUILTIN_TAB_KINDS,
  ROOT_LEAF_ID,
  type FeatureLayoutState,
  type LayoutLeaf,
} from "@/stores/feature-layout-schema";

/** The theme document, at the root of the project the theme is edited in. */
export const THEME_FILE_NAME = "theme.json";

const THEME_FILE_PANE_ID = "theme-file";

/**
 * How a theme project opens: the theme file on the left, the agent on the
 * right, so a change to either is visible next to the other.
 *
 * A starting point, not a mode — it is written once, when the conversation is
 * created, and from then on the pane layout is the user's like any other
 * feature's. Every tab is placed: this goes straight into the store, which
 * doesn't run the `parseLayoutState` pass that would otherwise adopt the ones
 * left out — hence the root pane taking whatever isn't the editor, rather than
 * a list that would silently drop a tab kind added later.
 */
export function themeLayoutState(): FeatureLayoutState {
  const file: LayoutLeaf = {
    type: "leaf",
    id: THEME_FILE_PANE_ID,
    tabIds: ["editor"],
    activeTabId: "editor",
  };
  const agent: LayoutLeaf = {
    type: "leaf",
    id: ROOT_LEAF_ID,
    tabIds: BUILTIN_TAB_KINDS.filter((kind) => kind !== "editor"),
    activeTabId: "agent",
  };
  return {
    version: 1,
    splitRoot: {
      type: "split",
      orientation: "horizontal",
      children: [file, agent],
      sizes: [55, 45],
    },
    // The agent side: the user came here to ask for a change, and the file is
    // in view either way.
    focusedPaneId: ROOT_LEAF_ID,
    appliedLayoutId: null,
  };
}
