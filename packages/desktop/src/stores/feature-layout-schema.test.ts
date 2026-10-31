import { describe, expect, it } from "vitest";
import {
  BUILTIN_TAB_KINDS,
  flatLayoutState,
  isPluginTabKind,
  isTabKind,
  pluginIdOfTab,
  pluginTabKind,
  parseLayoutState,
  serializeCurrentLayoutState,
  serializeLayoutForSave,
  serializeLayoutState,
  type FeatureLayoutState,
  type TabKind,
} from "./feature-layout-schema";

function flatTabIds(): TabKind[] {
  return [...BUILTIN_TAB_KINDS];
}

describe("parseLayoutState", () => {
  it("includes browser and preview in the flat default tab ids", () => {
    const state = flatLayoutState();
    expect(state.splitRoot.type).toBe("leaf");
    if (state.splitRoot.type === "leaf") {
      expect(state.splitRoot.tabIds).toEqual([
        "agent",
        "terminal",
        "git",
        "editor",
        "browser",
        "preview",
      ]);
    }
  });

  it("round-trips a flat default state", () => {
    const state = flatLayoutState();
    const json = serializeLayoutState(state);
    const parsed = parseLayoutState(json);
    expect(parsed).toEqual(state);
  });

  it("adds newly introduced tabs to the root pane when parsing an older saved layout", () => {
    const parsed = parseLayoutState({
      ...flatLayoutState(),
      splitRoot: {
        type: "leaf",
        id: "root",
        tabIds: ["agent", "terminal", "git", "editor"],
        activeTabId: "agent",
      },
    });

    expect(parsed?.splitRoot).toEqual({
      type: "leaf",
      id: "root",
      tabIds: ["agent", "terminal", "git", "editor", "browser", "preview"],
      activeTabId: "agent",
    });
  });

  it("drops the retired custom actions tab from a saved layout", () => {
    const parsed = parseLayoutState({
      ...flatLayoutState(),
      splitRoot: {
        type: "leaf",
        id: "root",
        tabIds: ["agent", "terminal", "git", "editor", "browser", "preview", "runs"],
        activeTabId: "runs",
      },
    });

    expect(parsed?.splitRoot).toMatchObject({
      tabIds: ["agent", "terminal", "git", "editor", "browser", "preview"],
      activeTabId: "agent",
    });
  });

  it("accepts a nested split tree containing the root leaf", () => {
    const state: FeatureLayoutState = {
      version: 1,
      splitRoot: {
        type: "split",
        orientation: "horizontal",
        sizes: [60, 40],
        children: [
          { type: "leaf", id: "root", tabIds: ["agent"], activeTabId: "agent" },
          {
            type: "split",
            orientation: "vertical",
            children: [
              { type: "leaf", id: "b", tabIds: ["terminal"], activeTabId: "terminal" },
              { type: "leaf", id: "c", tabIds: ["git", "editor"], activeTabId: "git" },
            ],
          },
        ],
      },
      focusedPaneId: "root",
      appliedLayoutId: 7,
    };
    if (state.splitRoot.type !== "split") throw new Error("Expected split test fixture");

    const parsed = parseLayoutState(serializeLayoutState(state));
    expect(parsed).toEqual({
      ...state,
      splitRoot: {
        ...state.splitRoot,
        children: [
          {
            type: "leaf",
            id: "root",
            tabIds: ["agent", "browser", "preview"],
            activeTabId: "agent",
          },
          state.splitRoot.children[1],
        ],
      },
    });
  });

  it("accepts both raw object and JSON string input", () => {
    const state = flatLayoutState();
    const fromObj = parseLayoutState(state);
    const fromJson = parseLayoutState(JSON.stringify(state));
    expect(fromObj).toEqual(state);
    expect(fromJson).toEqual(state);
  });

  it("preserves focus for current layouts but strips it from reusable templates", () => {
    const state = { ...flatLayoutState(), focusedPaneId: "root", appliedLayoutId: 99 };

    expect(parseLayoutState(serializeCurrentLayoutState(state))?.focusedPaneId).toBe("root");
    expect(parseLayoutState(serializeLayoutForSave(state))?.focusedPaneId).toBeNull();
    expect(parseLayoutState(serializeCurrentLayoutState(state))?.appliedLayoutId).toBeNull();
  });

  it("sanitizes stale focused pane ids", () => {
    const parsed = parseLayoutState({ ...flatLayoutState(), focusedPaneId: "missing-pane" });

    expect(parsed?.focusedPaneId).toBeNull();
  });

  it("rejects unknown version", () => {
    expect(parseLayoutState({ ...flatLayoutState(), version: 99 })).toBeNull();
  });

  // A saved layout must survive a tab kind going away (a removed plugin, a
  // build that doesn't know a newer tab): rejecting it reset the whole layout.
  it("drops unknown tab ids instead of rejecting the layout", () => {
    const parsed = parseLayoutState({
      ...flatLayoutState(),
      splitRoot: {
        type: "leaf",
        id: "root",
        tabIds: ["agent", "nope", "terminal", "git", "editor", "browser"],
        activeTabId: "nope",
      },
    });
    expect(parsed?.splitRoot).toEqual({
      type: "leaf",
      id: "root",
      tabIds: ["agent", "terminal", "git", "editor", "browser", "preview"],
      activeTabId: "agent",
    });
  });

  it("refills a root leaf left with only unknown ids", () => {
    const parsed = parseLayoutState({
      ...flatLayoutState(),
      splitRoot: { type: "leaf", id: "root", tabIds: ["nope"], activeTabId: null },
    });
    expect(parsed?.splitRoot).toEqual(flatLayoutState().splitRoot);
  });

  it("keeps valid plugin tab ids and drops invalid ones", () => {
    const parsed = parseLayoutState({
      ...flatLayoutState(),
      splitRoot: {
        type: "leaf",
        id: "root",
        tabIds: [
          ...flatTabIds(),
          "plugin:graph",
          "plugin:Bad_Id",
          "plugin:",
          "plugin:-edge",
          `plugin:${"a".repeat(65)}`,
        ],
        activeTabId: "plugin:graph",
      },
    });
    expect(parsed?.splitRoot).toEqual({
      type: "leaf",
      id: "root",
      tabIds: [...flatTabIds(), "plugin:graph"],
      activeTabId: "plugin:graph",
    });
  });

  it("keeps only the first occurrence of a duplicated tab id", () => {
    const parsed = parseLayoutState({
      ...flatLayoutState(),
      splitRoot: {
        type: "split",
        orientation: "horizontal",
        children: [
          {
            type: "leaf",
            id: "root",
            tabIds: [...flatTabIds(), "plugin:graph"],
            activeTabId: "agent",
          },
          { type: "leaf", id: "b", tabIds: ["plugin:graph", "terminal"], activeTabId: "terminal" },
        ],
      },
    });
    // "b" lost both of its tabs to earlier occurrences, so it collapsed.
    expect(parsed?.splitRoot).toEqual({
      type: "leaf",
      id: "root",
      tabIds: [...flatTabIds(), "plugin:graph"],
      activeTabId: "agent",
    });
  });

  it("falls back to the leaf's first tab when the active tab is gone or elsewhere", () => {
    const parsed = parseLayoutState({
      ...flatLayoutState(),
      focusedPaneId: "b",
      splitRoot: {
        type: "split",
        orientation: "vertical",
        sizes: [70, 30],
        children: [
          { type: "leaf", id: "root", tabIds: ["agent", "git", "editor"], activeTabId: "browser" },
          { type: "leaf", id: "b", tabIds: ["terminal", "browser"], activeTabId: "plugin:gone" },
        ],
      },
    });
    expect(parsed?.splitRoot).toEqual({
      type: "split",
      orientation: "vertical",
      sizes: [70, 30],
      children: [
        // A built-in missing from the stored layout joins the root strip.
        {
          type: "leaf",
          id: "root",
          tabIds: ["agent", "git", "editor", "preview"],
          activeTabId: "agent",
        },
        { type: "leaf", id: "b", tabIds: ["terminal", "browser"], activeTabId: "terminal" },
      ],
    });
    expect(parsed?.focusedPaneId).toBe("b");
  });

  it("collapses a non-root leaf emptied by dropped ids and clears its focus", () => {
    const parsed = parseLayoutState({
      ...flatLayoutState(),
      focusedPaneId: "b",
      splitRoot: {
        type: "split",
        orientation: "horizontal",
        sizes: [60, 40],
        children: [
          { type: "leaf", id: "root", tabIds: flatTabIds(), activeTabId: "git" },
          { type: "leaf", id: "b", tabIds: ["plugin:Nope", "mystery"], activeTabId: "mystery" },
        ],
      },
    });
    expect(parsed?.splitRoot).toEqual({
      type: "leaf",
      id: "root",
      tabIds: flatTabIds(),
      activeTabId: "git",
    });
    expect(parsed?.focusedPaneId).toBeNull();
  });

  it("keeps remembered auto-layout shares for plugin tabs", () => {
    const parsed = parseLayoutState({
      ...flatLayoutState(),
      autoShares: { "plugin:graph": 35, "plugin:BAD": 50, nope: 30 },
    });
    expect(parsed?.autoShares).toEqual({ "plugin:graph": 35 });
  });

  it("rejects a tree without a root leaf", () => {
    const state = {
      version: 1,
      splitRoot: { type: "leaf", id: "not-root", tabIds: ["agent"], activeTabId: "agent" },
      focusedPaneId: null,
      appliedLayoutId: null,
    };
    expect(parseLayoutState(state)).toBeNull();
  });

  it("rejects malformed split children count", () => {
    const state = {
      version: 1,
      splitRoot: {
        type: "split",
        orientation: "horizontal",
        children: [{ type: "leaf", id: "root", tabIds: [], activeTabId: null }],
      },
      focusedPaneId: null,
      appliedLayoutId: null,
    };
    expect(parseLayoutState(state)).toBeNull();
  });

  it("rejects garbage strings", () => {
    expect(parseLayoutState("not json")).toBeNull();
    expect(parseLayoutState("{")).toBeNull();
    expect(parseLayoutState(null)).toBeNull();
    expect(parseLayoutState(undefined)).toBeNull();
  });
});

describe("tab kinds", () => {
  it("recognizes built-in and well-formed plugin tabs only", () => {
    expect(BUILTIN_TAB_KINDS).toEqual(["agent", "terminal", "git", "editor", "browser", "preview"]);
    expect(Object.isFrozen(BUILTIN_TAB_KINDS)).toBe(true);
    expect(isTabKind("agent")).toBe(true);
    expect(isTabKind("plugin:changed-files-graph")).toBe(true);
    expect(isTabKind("plugin:a")).toBe(true);
    expect(isTabKind("nope")).toBe(false);
    expect(isPluginTabKind("agent")).toBe(false);
    expect(isPluginTabKind("plugin:ends-")).toBe(false);
    expect(isPluginTabKind(`plugin:${"a".repeat(64)}`)).toBe(true);
    expect(isPluginTabKind(`plugin:${"a".repeat(65)}`)).toBe(false);
  });

  it("maps plugin ids to tab kinds and back", () => {
    expect(pluginTabKind("graph")).toBe("plugin:graph");
    expect(pluginIdOfTab("plugin:graph")).toBe("graph");
    expect(pluginIdOfTab("git")).toBeNull();
    expect(() => pluginTabKind("Not Valid")).toThrow(/Invalid plugin tab id/);
  });
});
