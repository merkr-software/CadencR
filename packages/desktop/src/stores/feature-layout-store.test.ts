import { beforeEach, describe, expect, it } from "vitest";
import {
  activateFeatureTab,
  findHostFor,
  findLeafById,
  findPaneContaining,
  getFocusedTab,
  getLeaves,
  isTabVisible,
  selectFeatureLayout,
  useFeatureLayoutStore,
} from "./feature-layout-store";
import { flatLayoutState, ROOT_LEAF_ID } from "./feature-layout-schema";

const FEATURE = 42;

function reset(): void {
  useFeatureLayoutStore.setState({ features: {} });
}

function getState() {
  return selectFeatureLayout(FEATURE)(useFeatureLayoutStore.getState());
}

describe("feature-layout-store", () => {
  beforeEach(reset);

  it("starts in flat state with all five tabs in the root pane", () => {
    const state = getState();
    expect(state.splitRoot.type).toBe("leaf");
    if (state.splitRoot.type === "leaf") {
      expect(state.splitRoot.id).toBe(ROOT_LEAF_ID);
      expect(state.splitRoot.tabIds).toEqual(["agent", "terminal", "git", "editor", "browser"]);
      expect(state.splitRoot.activeTabId).toBe("agent");
    }
  });

  it("splitTabAt extracts a tab into a new sibling pane", () => {
    useFeatureLayoutStore.getState().splitTabAt(FEATURE, "terminal", ROOT_LEAF_ID, "right");
    const state = getState();
    expect(state.splitRoot.type).toBe("split");
    const leaves = getLeaves(state.splitRoot);
    expect(leaves).toHaveLength(2);
    const root = findLeafById(state.splitRoot, ROOT_LEAF_ID);
    expect(root?.tabIds).toEqual(["agent", "git", "editor", "browser"]);
    const newLeaf = leaves.find((l) => l.id !== ROOT_LEAF_ID);
    expect(newLeaf?.tabIds).toEqual(["terminal"]);
  });

  it("two splitTabAt calls produce a deeper split", () => {
    const store = useFeatureLayoutStore.getState();
    store.splitTabAt(FEATURE, "terminal", ROOT_LEAF_ID, "right");
    const firstNonRoot = getLeaves(getState().splitRoot).find((l) => l.id !== ROOT_LEAF_ID)!;
    store.splitTabAt(FEATURE, "git", firstNonRoot.id, "bottom");
    const state = getState();
    expect(getLeaves(state.splitRoot)).toHaveLength(3);
    const root = findLeafById(state.splitRoot, ROOT_LEAF_ID);
    expect(root?.tabIds).toEqual(["agent", "editor", "browser"]);
  });

  it("dockTab returns a tab to the root pane and collapses empty source", () => {
    const store = useFeatureLayoutStore.getState();
    store.splitTabAt(FEATURE, "terminal", ROOT_LEAF_ID, "right");
    store.dockTab(FEATURE, "terminal");
    const state = getState();
    expect(state.splitRoot.type).toBe("leaf"); // back to flat
    const root = findLeafById(state.splitRoot, ROOT_LEAF_ID);
    expect(root?.tabIds).toContain("terminal");
    expect(root?.activeTabId).toBe("terminal");
  });

  it("root leaf survives even when emptied", () => {
    const store = useFeatureLayoutStore.getState();
    for (const tab of ["agent", "terminal", "git", "editor", "browser"] as const) {
      store.splitTabAt(FEATURE, tab, ROOT_LEAF_ID, "right");
    }
    const state = getState();
    const root = findLeafById(state.splitRoot, ROOT_LEAF_ID);
    expect(root).not.toBeNull();
    expect(root?.tabIds).toEqual([]);
  });

  it("moveTabToPane co-locates two tabs in one pane", () => {
    const store = useFeatureLayoutStore.getState();
    store.splitTabAt(FEATURE, "terminal", ROOT_LEAF_ID, "right");
    const newLeaf = getLeaves(getState().splitRoot).find((l) => l.id !== ROOT_LEAF_ID)!;
    store.moveTabToPane(FEATURE, "git", newLeaf.id);
    const state = getState();
    const pane = findPaneContaining(state.splitRoot, "git");
    expect(pane).not.toBeNull();
    expect(pane!.tabIds).toEqual(["terminal", "git"]);
    expect(pane!.activeTabId).toBe("git");
    const root = findLeafById(state.splitRoot, ROOT_LEAF_ID);
    expect(root?.tabIds).toEqual(["agent", "editor", "browser"]);
  });

  it("setPaneActiveTab only switches when the tab lives in the pane", () => {
    const store = useFeatureLayoutStore.getState();
    store.splitTabAt(FEATURE, "terminal", ROOT_LEAF_ID, "right");
    store.setPaneActiveTab(FEATURE, ROOT_LEAF_ID, "git");
    const state = getState();
    const root = findLeafById(state.splitRoot, ROOT_LEAF_ID);
    expect(root?.activeTabId).toBe("git");
    // setting a tab not in the pane is a no-op
    store.setPaneActiveTab(FEATURE, ROOT_LEAF_ID, "terminal");
    const root2 = findLeafById(getState().splitRoot, ROOT_LEAF_ID);
    expect(root2?.activeTabId).toBe("git");
  });

  it("setSplitSizes persists sizes onto the matching split node", () => {
    const store = useFeatureLayoutStore.getState();
    store.splitTabAt(FEATURE, "terminal", ROOT_LEAF_ID, "right");
    store.setSplitSizes(FEATURE, [], [70, 30]);
    const state = getState();
    expect(state.splitRoot.type).toBe("split");
    if (state.splitRoot.type === "split") {
      expect(state.splitRoot.sizes).toEqual([70, 30]);
    }
  });

  it("findHostFor reports the pane id holding the tab", () => {
    const store = useFeatureLayoutStore.getState();
    store.splitTabAt(FEATURE, "terminal", ROOT_LEAF_ID, "right");
    const state = getState();
    expect(findHostFor(state, "agent")).toBe(ROOT_LEAF_ID);
    const newLeaf = getLeaves(state.splitRoot).find((l) => l.id !== ROOT_LEAF_ID)!;
    expect(findHostFor(state, "terminal")).toBe(newLeaf.id);
  });

  it("isTabVisible matches the host's active tab", () => {
    const store = useFeatureLayoutStore.getState();
    store.splitTabAt(FEATURE, "terminal", ROOT_LEAF_ID, "right");
    const newLeaf = getLeaves(getState().splitRoot).find((l) => l.id !== ROOT_LEAF_ID)!;
    store.moveTabToPane(FEATURE, "git", newLeaf.id);
    const state = getState();
    expect(isTabVisible(state, "git")).toBe(true);
    expect(isTabVisible(state, "terminal")).toBe(false);
    expect(isTabVisible(state, "agent")).toBe(true);
  });

  it("resetToFlat brings everything back to the root pane", () => {
    const store = useFeatureLayoutStore.getState();
    store.splitTabAt(FEATURE, "terminal", ROOT_LEAF_ID, "right");
    store.resetToFlat(FEATURE);
    const state = getState();
    expect(state.splitRoot.type).toBe("leaf");
    if (state.splitRoot.type === "leaf") {
      expect(state.splitRoot.tabIds).toEqual(["agent", "terminal", "git", "editor", "browser"]);
    }
  });

  it("resetToFlat keeps auto layout's size memory", () => {
    const store = useFeatureLayoutStore.getState();
    store.setState(FEATURE, { ...flatLayoutState(), autoShares: { browser: 35 } });
    store.splitTabAt(FEATURE, "browser", ROOT_LEAF_ID, "right");
    store.resetToFlat(FEATURE);
    expect(getState().autoShares).toEqual({ browser: 35 });
  });

  it("setFocusedPane is a no-op when the pane is already focused", () => {
    const store = useFeatureLayoutStore.getState();
    store.setFocusedPane(FEATURE, ROOT_LEAF_ID);
    const before = getState();
    store.setFocusedPane(FEATURE, ROOT_LEAF_ID);
    const after = getState();
    // Same reference proves the store skipped the rebuild — selectors won't fire.
    expect(after).toBe(before);
  });

  it("setPaneActiveTab is a no-op when the tab is already active and pane focused", () => {
    const store = useFeatureLayoutStore.getState();
    store.setPaneActiveTab(FEATURE, ROOT_LEAF_ID, "terminal");
    const before = getState();
    store.setPaneActiveTab(FEATURE, ROOT_LEAF_ID, "terminal");
    const after = getState();
    expect(after).toBe(before);
  });

  it("setPaneActiveTab still fires when only focus changes", () => {
    const store = useFeatureLayoutStore.getState();
    store.splitTabAt(FEATURE, "terminal", ROOT_LEAF_ID, "right");
    const newLeaf = getLeaves(getState().splitRoot).find((l) => l.id !== ROOT_LEAF_ID)!;
    // newLeaf is now focused because splitTabAt sets focus to the new pane.
    // Invoking setPaneActiveTab on the root with its existing active tab must
    // still update focusedPaneId to root, even though splitRoot is unchanged.
    const before = getState();
    store.setPaneActiveTab(FEATURE, ROOT_LEAF_ID, "agent");
    const after = getState();
    expect(after).not.toBe(before);
    expect(after.focusedPaneId).toBe(ROOT_LEAF_ID);
    expect(after.splitRoot).toBe(before.splitRoot);
    expect(newLeaf.id).not.toBe(ROOT_LEAF_ID);
  });

  it("getFocusedTab returns the active tab from the focused pane", () => {
    const store = useFeatureLayoutStore.getState();
    store.splitTabAt(FEATURE, "terminal", ROOT_LEAF_ID, "right");
    const newLeaf = getLeaves(getState().splitRoot).find((l) => l.id !== ROOT_LEAF_ID)!;

    expect(getFocusedTab(getState())).toBe("terminal");

    store.setPaneActiveTab(FEATURE, ROOT_LEAF_ID, "agent");
    expect(getFocusedTab(getState())).toBe("agent");
    expect(newLeaf.id).not.toBe(ROOT_LEAF_ID);
  });

  it("activateFeatureTab works for an unhydrated feature by falling back to the empty layout", () => {
    // Regression test: the unified agent view skips layout hydration for its
    // embedded cards, so `features[featureId]` is missing when the hotkey
    // fires. The helper must still locate the tab and update state.
    expect(useFeatureLayoutStore.getState().features[FEATURE]).toBeUndefined();
    expect(activateFeatureTab(FEATURE, "terminal")).toBe(true);
    const layout = getState();
    expect(layout.splitRoot.type).toBe("leaf");
    if (layout.splitRoot.type === "leaf") {
      expect(layout.splitRoot.activeTabId).toBe("terminal");
    }
  });

  it("activateFeatureTab switches the active tab for a hydrated feature", () => {
    const store = useFeatureLayoutStore.getState();
    store.splitTabAt(FEATURE, "git", ROOT_LEAF_ID, "right");
    expect(activateFeatureTab(FEATURE, "git")).toBe(true);
    const gitLeaf = getLeaves(getState().splitRoot).find((l) => l.tabIds.includes("git"))!;
    expect(gitLeaf.activeTabId).toBe("git");
  });
});
