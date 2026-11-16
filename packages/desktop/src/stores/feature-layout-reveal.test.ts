import { describe, expect, it } from "vitest";

import {
  flatLayoutState,
  parseLayoutState,
  serializeCurrentLayoutState,
  serializeLayoutForSave,
  type FeatureLayoutState,
  type LayoutLeaf,
  type LayoutNode,
} from "./feature-layout-schema";
import {
  choosePlacement,
  DEFAULT_AUTO_SHARE,
  planReveal,
  rememberAutoShares,
} from "./feature-layout-reveal";
import { findPaneContaining, getLeaves } from "./feature-layout-tree";

const RIGHT = { placement: "right", focus: false } as const;

function leaf(id: string, tabIds: LayoutLeaf["tabIds"], activeTabId = tabIds[0]): LayoutLeaf {
  return { type: "leaf", id, tabIds, activeTabId: activeTabId ?? null };
}

function withRoot(splitRoot: LayoutNode, focusedPaneId = "root"): FeatureLayoutState {
  return { version: 1, splitRoot, focusedPaneId, appliedLayoutId: null };
}

function applied(result: ReturnType<typeof planReveal>): FeatureLayoutState {
  if (!("state" in result)) throw new Error(`expected a layout change, got ${result.kind}`);
  return result.state;
}

describe("planReveal", () => {
  it("splits the browser off to the right of the agent in a flat layout", () => {
    const result = planReveal(flatLayoutState(), "browser", RIGHT);
    expect(result.kind).toBe("split");
    const state = applied(result);
    const root = state.splitRoot;
    expect(root).toMatchObject({
      type: "split",
      orientation: "horizontal",
      sizes: [100 - DEFAULT_AUTO_SHARE, DEFAULT_AUTO_SHARE],
    });
    expect(findPaneContaining(root, "agent")?.activeTabId).toBe("agent");
    const browserPane = findPaneContaining(root, "browser");
    expect(browserPane).toMatchObject({ tabIds: ["browser"], activeTabId: "browser" });
    expect(browserPane?.id).not.toBe("root");
  });

  it("opens the split at the remembered share", () => {
    const state = { ...flatLayoutState(), autoShares: { browser: 55 } };
    const root = applied(planReveal(state, "browser", RIGHT)).splitRoot;
    expect(root).toMatchObject({ type: "split", sizes: [45, 55] });
  });

  it("splits below when the placement is bottom", () => {
    const root = applied(
      planReveal(flatLayoutState(), "browser", { placement: "bottom", focus: false }),
    ).splitRoot;
    expect(root).toMatchObject({ type: "split", orientation: "vertical" });
  });

  it("keeps hotkey focus where it was for agent reveals and moves it for user reveals", () => {
    const quiet = applied(planReveal(flatLayoutState(), "browser", RIGHT));
    expect(quiet.focusedPaneId).toBe("root");
    const loud = applied(planReveal(flatLayoutState(), "browser", { ...RIGHT, focus: true }));
    expect(loud.focusedPaneId).toBe(findPaneContaining(loud.splitRoot, "browser")?.id);
  });

  it("moves the browser into the existing secondary pane instead of adding a third", () => {
    const state = withRoot({
      type: "split",
      orientation: "horizontal",
      children: [leaf("root", ["agent", "browser", "editor"]), leaf("side", ["git", "terminal"])],
    });
    const result = planReveal(state, "browser", RIGHT);
    expect(result.kind).toBe("moved");
    const next = applied(result);
    expect(getLeaves(next.splitRoot)).toHaveLength(2);
    expect(findPaneContaining(next.splitRoot, "browser")).toMatchObject({
      id: "side",
      tabIds: ["git", "terminal", "browser"],
      activeTabId: "browser",
    });
    expect(findPaneContaining(next.splitRoot, "agent")?.activeTabId).toBe("agent");
  });

  it("activates the browser where it already lives when that isn't the agent's pane", () => {
    const state = withRoot({
      type: "split",
      orientation: "horizontal",
      children: [leaf("root", ["agent"]), leaf("side", ["git", "browser"], "git")],
    });
    const result = planReveal(state, "browser", RIGHT);
    expect(result.kind).toBe("activated");
    expect(findPaneContaining(applied(result).splitRoot, "browser")?.activeTabId).toBe("browser");
  });

  it("does nothing when the browser is already showing", () => {
    const state = withRoot({
      type: "split",
      orientation: "horizontal",
      children: [leaf("root", ["agent"]), leaf("side", ["browser"])],
    });
    expect(planReveal(state, "browser", RIGHT).kind).toBe("noop");
  });

  it("only moves focus when a user reveal targets an already-visible tab", () => {
    const state = withRoot({
      type: "split",
      orientation: "horizontal",
      children: [leaf("root", ["agent"]), leaf("side", ["browser"])],
    });
    const result = planReveal(state, "browser", { ...RIGHT, focus: true });
    expect(result.kind).toBe("activated");
    expect(applied(result).focusedPaneId).toBe("side");
  });

  it("refuses to hide the agent when there is no room to split", () => {
    expect(planReveal(flatLayoutState(), "browser", { placement: null, focus: true }).kind).toBe(
      "blocked",
    );
  });
});

describe("rememberAutoShares", () => {
  it("records the share of a secondary pane beside the agent", () => {
    const state = withRoot({
      type: "split",
      orientation: "horizontal",
      children: [leaf("root", ["agent", "git"]), leaf("side", ["browser", "terminal"])],
      sizes: [64.4, 35.6],
    });
    expect(rememberAutoShares(state, []).autoShares).toEqual({ browser: 36, terminal: 36 });
  });

  it("clamps extreme shares and ignores splits without the agent", () => {
    const clamped = withRoot({
      type: "split",
      orientation: "horizontal",
      children: [leaf("side", ["browser"]), leaf("root", ["agent"])],
      sizes: [92, 8],
    });
    expect(rememberAutoShares(clamped, []).autoShares).toEqual({ browser: 80 });

    const nested = withRoot({
      type: "split",
      orientation: "horizontal",
      children: [
        leaf("root", ["agent"]),
        {
          type: "split",
          orientation: "vertical",
          children: [leaf("a", ["git"]), leaf("b", ["browser"])],
          sizes: [30, 70],
        },
      ],
    });
    expect(rememberAutoShares(nested, [1])).toBe(nested);
  });
});

describe("autoShares persistence", () => {
  it("round-trips through the per-feature layout but never into a saved template", () => {
    const state = { ...flatLayoutState(), autoShares: { browser: 42 } };
    expect(parseLayoutState(serializeCurrentLayoutState(state))?.autoShares).toEqual({
      browser: 42,
    });
    expect(parseLayoutState(serializeLayoutForSave(state))?.autoShares).toBeUndefined();
  });

  it("drops unknown tabs and clamps out-of-range shares on parse", () => {
    const raw = JSON.stringify({
      ...flatLayoutState(),
      autoShares: { browser: 5, bogus: 50, git: "40" },
    });
    expect(parseLayoutState(raw)?.autoShares).toEqual({ browser: 20 });
  });
});

describe("choosePlacement", () => {
  it("splits right when wide, below when tall and narrow, not at all when cramped", () => {
    expect(choosePlacement({ width: 1400, height: 800 })).toBe("right");
    expect(choosePlacement({ width: 700, height: 900 })).toBe("bottom");
    expect(choosePlacement({ width: 760, height: 500 })).toBe("right");
    expect(choosePlacement({ width: 700, height: 500 })).toBeNull();
  });
});
