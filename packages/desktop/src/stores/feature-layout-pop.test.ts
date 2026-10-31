import { beforeEach, describe, expect, it } from "vitest";

import {
  parseLayoutState,
  serializeLayoutForSave,
  type FeatureLayoutState,
  type LayoutLeaf,
  type LayoutNode,
  type LayoutSplit,
  type SplitOrientation,
} from "./feature-layout-schema";
import { planReveal } from "./feature-layout-reveal";
import {
  isAgentAlone,
  isPopCollapsed,
  isTabVisible,
  selectFeatureLayout,
  useFeatureLayoutStore,
} from "./feature-layout-store";
import { findLeafById, isPopLeaf, popChildIndex, setLeafPop } from "./feature-layout-tree";

const FEATURE = 7;

function leaf(id: string, tabIds: LayoutLeaf["tabIds"], pop?: true): LayoutLeaf {
  return { type: "leaf", id, tabIds, activeTabId: tabIds[0] ?? null, ...(pop ? { pop } : {}) };
}

function split(
  a: LayoutNode,
  b: LayoutNode,
  orientation: SplitOrientation = "vertical",
): LayoutSplit {
  return { type: "split", orientation, children: [a, b], sizes: [70, 30] };
}

function withRoot(
  splitRoot: LayoutNode,
  focusedPaneId: string | null = "root",
): FeatureLayoutState {
  return { version: 1, splitRoot, focusedPaneId, appliedLayoutId: null };
}

/** Agent on top, a terminal pane popping along the bottom edge. */
function terminalAtBottom(pop = true): LayoutSplit {
  return split(
    leaf("root", ["agent", "git", "editor", "browser", "preview"]),
    leaf("term", ["terminal"], pop ? true : undefined),
  );
}

describe("pop pane tree helpers", () => {
  it("names the flagged non-root child of a split", () => {
    expect(popChildIndex(terminalAtBottom())).toBe(1);
    expect(popChildIndex(terminalAtBottom(false))).toBeNull();
    // The root leaf never pops, even when a payload flags it.
    expect(popChildIndex(split(leaf("root", ["agent"], true), leaf("t", ["terminal"])))).toBeNull();
    // Both sides flagged: the first one wins.
    expect(popChildIndex(split(leaf("a", ["git"], true), leaf("b", ["terminal"], true)))).toBe(0);
  });

  it("finds pop panes anywhere in the tree", () => {
    const tree = split(terminalAtBottom(), leaf("side", ["git"]), "horizontal");
    expect(isPopLeaf(tree, "term")).toBe(true);
    expect(isPopLeaf(tree, "side")).toBe(false);
    expect(isPopLeaf(tree, "root")).toBe(false);
  });

  it("tells when the agent is the only open pane, its pop panes folded", () => {
    const alone = (tree: LayoutNode, focus: string): boolean => isAgentAlone(withRoot(tree, focus));
    const popRail = (side: LayoutLeaf): LayoutSplit =>
      split(terminalAtBottom(), side, "horizontal");
    expect(alone(terminalAtBottom(), "root")).toBe(true);
    expect(alone(popRail(leaf("side", ["git"], true)), "root")).toBe(true);
    // A focused pop pane is open, and so is any plain split pane.
    expect(alone(terminalAtBottom(), "term")).toBe(false);
    expect(alone(popRail(leaf("side", ["git"], true)), "side")).toBe(false);
    expect(alone(popRail(leaf("side", ["git"])), "root")).toBe(false);
    expect(alone(terminalAtBottom(false), "root")).toBe(false);
    // A pop pane beside a subtree without the root leaves that subtree open.
    const away = split(
      leaf("root", ["agent"]),
      split(leaf("a", ["git"], true), leaf("b", ["editor"])),
    );
    expect(alone(away, "root")).toBe(false);
    // The root showing another tab, or no split at all.
    const editorRoot = split(leaf("root", ["editor", "agent"]), leaf("term", ["terminal"], true));
    expect(alone(editorRoot, "root")).toBe(false);
    expect(alone(leaf("root", ["agent"]), "root")).toBe(false);
  });

  it("flags a pane and clears its sibling's flag, so one side stays open", () => {
    const both = split(
      leaf("root", ["agent"]),
      split(leaf("a", ["git"], true), leaf("b", ["terminal"])),
    );
    const next = setLeafPop(both, "b", true);
    expect(findLeafById(next, "b")?.pop).toBe(true);
    expect(findLeafById(next, "a")).not.toHaveProperty("pop");
  });

  it("unflags a pane without leaving a `pop` key behind, and never flags the root", () => {
    const tree = terminalAtBottom();
    expect(findLeafById(setLeafPop(tree, "term", false), "term")).not.toHaveProperty("pop");
    expect(setLeafPop(tree, "root", true)).toBe(tree);
    expect(setLeafPop(tree, "term", true)).toBe(tree);
  });
});

describe("pop pane persistence", () => {
  it("keeps the flag through a parse and a saved layout, dropping anything but `true` and the root's", () => {
    const saved = serializeLayoutForSave(withRoot(terminalAtBottom()));
    expect(findLeafById(parseLayoutState(saved)!.splitRoot, "term")?.pop).toBe(true);

    const garbled = JSON.parse(saved) as { splitRoot: { children: Record<string, unknown>[] } };
    garbled.splitRoot.children[1].pop = "yes";
    garbled.splitRoot.children[0].pop = true;
    const parsed = parseLayoutState(JSON.stringify(garbled));
    expect(findLeafById(parsed!.splitRoot, "term")).not.toHaveProperty("pop");
    expect(findLeafById(parsed!.splitRoot, "root")).not.toHaveProperty("pop");
  });
});

describe("pop pane visibility", () => {
  beforeEach(() => useFeatureLayoutStore.setState({ features: {} }));

  it("folds the pane, and hides its tab, until the pane takes focus", () => {
    const store = useFeatureLayoutStore.getState();
    store.setState(FEATURE, withRoot(terminalAtBottom()));
    const state = (): FeatureLayoutState =>
      selectFeatureLayout(FEATURE)(useFeatureLayoutStore.getState());

    expect(isPopCollapsed(state(), "term")).toBe(true);
    expect(isTabVisible(state(), "terminal")).toBe(false);

    store.setFocusedPane(FEATURE, "term");
    expect(isPopCollapsed(state(), "term")).toBe(false);
    expect(isTabVisible(state(), "terminal")).toBe(true);

    store.setFocusedPane(FEATURE, "root");
    expect(isTabVisible(state(), "terminal")).toBe(false);
  });

  it("toggles through the store action", () => {
    const store = useFeatureLayoutStore.getState();
    store.setState(FEATURE, withRoot(terminalAtBottom(false)));
    store.setPanePop(FEATURE, "term", true);
    const root = selectFeatureLayout(FEATURE)(useFeatureLayoutStore.getState()).splitRoot;
    expect(findLeafById(root, "term")?.pop).toBe(true);
  });
});

describe("auto layout reveal with pop panes", () => {
  it("does not move a revealed tab into a pop pane", () => {
    const state = withRoot(
      split(leaf("root", ["agent", "browser"]), leaf("term", ["terminal"], true), "horizontal"),
    );
    const result = planReveal(state, "browser", { placement: "right", focus: false });
    expect(result.kind).toBe("split");
    if (!("state" in result)) return;
    expect(findLeafById(result.state.splitRoot, "term")?.tabIds).toEqual(["terminal"]);
  });

  it("flags a folded pop pane already showing the tab, without opening it", () => {
    const state = withRoot(split(leaf("root", ["agent"]), leaf("term", ["terminal"], true)));
    const result = planReveal(state, "terminal", { placement: "right", focus: false });
    expect(result).toEqual({ kind: "activated", state, paneId: "term" });

    const open = { ...state, focusedPaneId: "term" };
    expect(planReveal(open, "terminal", { placement: "right", focus: false }).kind).toBe("noop");
  });
});
