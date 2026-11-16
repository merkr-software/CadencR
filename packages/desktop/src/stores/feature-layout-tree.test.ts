import { describe, expect, it } from "vitest";

import {
  BUILTIN_TAB_KINDS,
  flatLayoutState,
  type FeatureLayoutState,
} from "./feature-layout-schema";
import { getPluginTabs, restrictLayoutToTabs, storedSplitPath } from "./feature-layout-tree";

const ALL_BUILTINS = new Set<string>(BUILTIN_TAB_KINDS);

function splitWithPlugins(): FeatureLayoutState {
  return {
    ...flatLayoutState(),
    focusedPaneId: "p",
    splitRoot: {
      type: "split",
      orientation: "horizontal",
      sizes: [60, 40],
      children: [
        {
          type: "leaf",
          id: "root",
          tabIds: [...BUILTIN_TAB_KINDS, "plugin:graph"],
          activeTabId: "plugin:graph",
        },
        { type: "leaf", id: "p", tabIds: ["plugin:board"], activeTabId: "plugin:board" },
      ],
    },
  };
}

describe("restrictLayoutToTabs", () => {
  it("returns the very same state when every placed tab is available", () => {
    const state = flatLayoutState();
    expect(restrictLayoutToTabs(state, ALL_BUILTINS)).toBe(state);

    const withPlugins = splitWithPlugins();
    const available = new Set([...ALL_BUILTINS, "plugin:graph", "plugin:board", "plugin:extra"]);
    expect(restrictLayoutToTabs(withPlugins, available)).toBe(withPlugins);
  });

  it("hides unavailable tabs, fixes active tabs and collapses emptied panes", () => {
    const state = splitWithPlugins();
    const view = restrictLayoutToTabs(state, ALL_BUILTINS);
    expect(view.splitRoot).toEqual({
      type: "leaf",
      id: "root",
      tabIds: [...BUILTIN_TAB_KINDS],
      activeTabId: "agent",
    });
    expect(view.focusedPaneId).toBeNull();
    // The stored layout is untouched: re-enabling brings the tabs back in place.
    expect(getPluginTabs(state.splitRoot)).toEqual(["plugin:graph", "plugin:board"]);
  });

  it("shares untouched subtrees", () => {
    const state = splitWithPlugins();
    const view = restrictLayoutToTabs(state, new Set([...ALL_BUILTINS, "plugin:board"]));
    if (view.splitRoot.type !== "split" || state.splitRoot.type !== "split") {
      throw new Error("expected a split");
    }
    expect(view.splitRoot.sizes).toEqual([60, 40]);
    expect(view.splitRoot.children[1]).toBe(state.splitRoot.children[1]);
    expect(view.splitRoot.children[0]).toMatchObject({ activeTabId: "agent" });
    expect(view.focusedPaneId).toBe("p");
  });

  it("maps a split that moved up in the view to its stored path", () => {
    // root | (plugin-only pane over terminal pane): hiding the plugin collapses
    // the root split, so the inner split renders at [] but is stored at [1].
    const state: FeatureLayoutState = {
      ...flatLayoutState(),
      splitRoot: {
        type: "split",
        orientation: "horizontal",
        children: [
          { type: "leaf", id: "p", tabIds: ["plugin:graph"], activeTabId: "plugin:graph" },
          {
            type: "split",
            orientation: "vertical",
            children: [
              { type: "leaf", id: "root", tabIds: ["agent"], activeTabId: "agent" },
              { type: "leaf", id: "t", tabIds: ["terminal"], activeTabId: "terminal" },
            ],
          },
        ],
      },
    };
    const view = restrictLayoutToTabs(state, ALL_BUILTINS);
    if (view.splitRoot.type !== "split") throw new Error("expected the inner split");
    expect(view.splitRoot.orientation).toBe("vertical");
    expect(storedSplitPath(view.splitRoot, [])).toEqual([1]);
  });
});
