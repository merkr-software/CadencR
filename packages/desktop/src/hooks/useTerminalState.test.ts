// @vitest-environment happy-dom
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import {
  useTerminalState,
  useTerminalStore,
  getLeaves,
  findAdjacentLeaf,
  type SplitNode,
  type TerminalLeaf,
} from "./useTerminalState";

describe("useTerminalState", () => {
  beforeEach(() => {
    useTerminalStore.setState({ features: {} });
  });

  it("starts with panel closed and no panes", () => {
    const { result } = renderHook(() => useTerminalState(1));
    expect(result.current.isOpen).toBe(false);
    expect(result.current.isMinimized).toBe(false);
    expect(result.current.panes).toEqual([]);
    expect(result.current.root).toBeNull();
  });

  it("togglePanel opens panel with a new pane when closed", () => {
    const { result } = renderHook(() => useTerminalState(1));
    act(() => result.current.togglePanel());
    expect(result.current.isOpen).toBe(true);
    expect(result.current.panes).toHaveLength(1);
    expect(result.current.root?.type).toBe("leaf");
  });

  it("togglePanel closes panel when open", () => {
    const { result } = renderHook(() => useTerminalState(1));
    act(() => result.current.togglePanel());
    act(() => result.current.togglePanel());
    expect(result.current.isOpen).toBe(false);
  });

  it("addPane adds a pane via horizontal split", () => {
    const { result } = renderHook(() => useTerminalState(1));
    act(() => result.current.togglePanel());
    act(() => result.current.addPane());
    expect(result.current.panes).toHaveLength(2);
    expect(result.current.root?.type).toBe("split");
  });

  it("adoptPtys hydrates an empty feature with leaves bound to existing PTYs", () => {
    const { result } = renderHook(() => useTerminalState(1));
    act(() =>
      useTerminalStore
        .getState()
        .adoptPtys(1, [{ ptyId: "pty-a", cwd: "/work" }, { ptyId: "pty-b" }]),
    );
    expect(result.current.isOpen).toBe(true);
    expect(result.current.panes.map((p) => p.ptyId)).toEqual(["pty-a", "pty-b"]);
    expect(result.current.panes[0].cwd).toBe("/work");
  });

  it("adoptPtys is a no-op when the feature already has panes", () => {
    const { result } = renderHook(() => useTerminalState(1));
    act(() => result.current.togglePanel()); // one fresh pane, no ptyId
    act(() => useTerminalStore.getState().adoptPtys(1, [{ ptyId: "pty-a" }]));
    expect(result.current.panes).toHaveLength(1);
    expect(result.current.panes[0].ptyId).toBeUndefined();
  });

  it("splitPane returns the id of the newly-created leaf", () => {
    const { result } = renderHook(() => useTerminalState(1));
    act(() => result.current.togglePanel());
    const firstId = result.current.panes[0].id;
    let newId: string | null = null;
    act(() => {
      newId = result.current.splitPane(firstId, "horizontal");
    });
    // The returned id must be one of the two leaves after the split, and
    // distinct from the pre-existing one — callers rely on this to focus
    // the new split.
    const leafIds = result.current.panes.map((p) => p.id);
    expect(leafIds).toHaveLength(2);
    expect(leafIds).toContain(newId);
    expect(newId).not.toBe(firstId);
  });

  it("addPane returns the id of the newly-created leaf", () => {
    const { result } = renderHook(() => useTerminalState(1));
    // First addPane on an empty panel creates the root leaf and returns it.
    let firstNewId: string | null = null;
    act(() => {
      firstNewId = result.current.addPane();
    });
    expect(result.current.panes).toHaveLength(1);
    expect(firstNewId).toBe(result.current.panes[0].id);

    // Subsequent addPane splits the last leaf and returns the *new* leaf id.
    let secondNewId: string | null = null;
    act(() => {
      secondNewId = result.current.addPane();
    });
    expect(result.current.panes).toHaveLength(2);
    expect(secondNewId).toBe(result.current.panes[1].id);
    expect(secondNewId).not.toBe(firstNewId);
  });

  it("splitPane creates a vertical split (stacked)", () => {
    const { result } = renderHook(() => useTerminalState(1));
    act(() => result.current.togglePanel());
    const leafId = result.current.panes[0].id;
    act(() => result.current.splitPane(leafId, "vertical"));
    expect(result.current.panes).toHaveLength(2);
    const root = result.current.root;
    expect(root?.type).toBe("split");
    if (root?.type === "split") {
      expect(root.orientation).toBe("vertical");
    }
  });

  it("splitPane supports mixed orientations", () => {
    const { result } = renderHook(() => useTerminalState(1));
    act(() => result.current.togglePanel());
    const firstId = result.current.panes[0].id;
    // Split first pane horizontally (side-by-side)
    act(() => result.current.splitPane(firstId, "horizontal"));
    expect(result.current.panes).toHaveLength(2);
    // Now split the second pane vertically (stacked)
    const secondId = result.current.panes[1].id;
    act(() => result.current.splitPane(secondId, "vertical"));
    expect(result.current.panes).toHaveLength(3);
    // Root should be horizontal, right child should be vertical
    const root = result.current.root;
    expect(root?.type).toBe("split");
    if (root?.type === "split") {
      expect(root.orientation).toBe("horizontal");
      expect(root.children[0].type).toBe("leaf");
      expect(root.children[1].type).toBe("split");
      if (root.children[1].type === "split") {
        expect(root.children[1].orientation).toBe("vertical");
      }
    }
  });

  it("removePane removes a pane by id", () => {
    const { result } = renderHook(() => useTerminalState(1));
    act(() => result.current.togglePanel());
    const paneId = result.current.panes[0].id;
    act(() => result.current.removePane(paneId));
    expect(result.current.panes).toHaveLength(0);
    expect(result.current.isOpen).toBe(false);
  });

  it("removePane collapses split when one child removed", () => {
    const { result } = renderHook(() => useTerminalState(1));
    act(() => result.current.togglePanel());
    act(() => result.current.addPane());
    expect(result.current.panes).toHaveLength(2);
    const firstId = result.current.panes[0].id;
    act(() => result.current.removePane(firstId));
    expect(result.current.panes).toHaveLength(1);
    // Tree should collapse back to a single leaf
    expect(result.current.root?.type).toBe("leaf");
  });

  it("removePane closes panel when last pane removed", () => {
    const { result } = renderHook(() => useTerminalState(1));
    act(() => result.current.togglePanel());
    const paneId = result.current.panes[0].id;
    act(() => result.current.removePane(paneId));
    expect(result.current.isOpen).toBe(false);
  });

  it("minimize sets isMinimized", () => {
    const { result } = renderHook(() => useTerminalState(1));
    act(() => result.current.togglePanel());
    act(() => result.current.minimize());
    expect(result.current.isMinimized).toBe(true);
    expect(result.current.isOpen).toBe(true);
  });

  it("closePanel clears all state", () => {
    const { result } = renderHook(() => useTerminalState(1));
    act(() => result.current.togglePanel());
    act(() => result.current.addPane());
    act(() => result.current.closePanel());
    expect(result.current.isOpen).toBe(false);
    expect(result.current.panes).toHaveLength(0);
  });

  it("state is isolated per featureId", () => {
    const { result: r1 } = renderHook(() => useTerminalState(1));
    const { result: r2 } = renderHook(() => useTerminalState(2));
    act(() => r1.current.togglePanel());
    expect(r1.current.isOpen).toBe(true);
    expect(r2.current.isOpen).toBe(false);
  });

  it("setPtyId associates ptyId with a pane", () => {
    const { result } = renderHook(() => useTerminalState(1));
    act(() => result.current.togglePanel());
    const paneId = result.current.panes[0].id;
    act(() => useTerminalStore.getState().setPtyId(1, paneId, "pty-123"));
    const root = useTerminalStore.getState().features[1].root;
    expect(root?.type).toBe("leaf");
    if (root?.type === "leaf") {
      expect(root.ptyId).toBe("pty-123");
    }
  });

  it("setPtyId is a no-op when the value is unchanged", () => {
    const { result } = renderHook(() => useTerminalState(1));
    act(() => result.current.togglePanel());
    const paneId = result.current.panes[0].id;
    act(() => useTerminalStore.getState().setPtyId(1, paneId, "pty-1"));
    const before = useTerminalStore.getState().features[1];
    act(() => useTerminalStore.getState().setPtyId(1, paneId, "pty-1"));
    const after = useTerminalStore.getState().features[1];
    expect(after).toBe(before);
  });

  it("setPaneCwd records the cwd on the leaf", () => {
    const { result } = renderHook(() => useTerminalState(1));
    act(() => result.current.togglePanel());
    const paneId = result.current.panes[0].id;
    act(() => useTerminalStore.getState().setPaneCwd(1, paneId, "/work/wt"));
    const root = useTerminalStore.getState().features[1].root;
    expect(root?.type).toBe("leaf");
    if (root?.type === "leaf") {
      expect(root.cwd).toBe("/work/wt");
    }
  });

  it("dismissCwdWarning sticks across cwd updates so a dismissed warning stays dismissed", () => {
    const { result } = renderHook(() => useTerminalState(1));
    act(() => result.current.togglePanel());
    const paneId = result.current.panes[0].id;
    act(() => useTerminalStore.getState().setPaneCwd(1, paneId, "/old"));
    act(() => useTerminalStore.getState().dismissCwdWarning(1, paneId));
    // Re-emit the same cwd (e.g. on reconnect) — the dismissal should not be reset.
    act(() => useTerminalStore.getState().setPaneCwd(1, paneId, "/old"));
    const root = useTerminalStore.getState().features[1].root;
    expect(root?.type).toBe("leaf");
    if (root?.type === "leaf") {
      expect(root.cwdWarningDismissed).toBe(true);
    }
  });

  it("replaceLeafWithFresh swaps the leaf id and clears its PTY metadata", () => {
    const { result } = renderHook(() => useTerminalState(1));
    act(() => result.current.togglePanel());
    const paneId = result.current.panes[0].id;
    act(() => {
      const store = useTerminalStore.getState();
      store.setPtyId(1, paneId, "pty-1");
      store.setPaneCwd(1, paneId, "/old");
      store.dismissCwdWarning(1, paneId);
    });
    act(() => useTerminalStore.getState().replaceLeafWithFresh(1, paneId));
    const newPaneId = result.current.panes[0].id;
    expect(newPaneId).not.toBe(paneId);
    const root = result.current.root;
    expect(root?.type).toBe("leaf");
    if (root?.type === "leaf") {
      expect(root.ptyId).toBeUndefined();
      expect(root.cwd).toBeUndefined();
      expect(root.cwdWarningDismissed).toBeUndefined();
    }
  });

  it("replaceLeafWithFresh carries an optional notice onto the fresh leaf", () => {
    const { result } = renderHook(() => useTerminalState(1));
    act(() => result.current.togglePanel());
    const paneId = result.current.panes[0].id;
    act(() => useTerminalStore.getState().replaceLeafWithFresh(1, paneId, "/repo/.worktrees/x"));
    const root = result.current.root;
    if (root?.type === "leaf") {
      expect(root.initialNotice).toBe("/repo/.worktrees/x");
    }
  });

  it("clearInitialNotice removes the consumed notice from the leaf", () => {
    const { result } = renderHook(() => useTerminalState(1));
    act(() => result.current.togglePanel());
    const paneId = result.current.panes[0].id;
    act(() => useTerminalStore.getState().replaceLeafWithFresh(1, paneId, "/repo/wt"));
    const freshId = result.current.panes[0].id;
    act(() => useTerminalStore.getState().clearInitialNotice(1, freshId));
    const root = result.current.root;
    if (root?.type === "leaf") {
      expect(root.initialNotice).toBeUndefined();
    }
  });

  // Helper to build leaf nodes for navigation tests
  const leaf = (id: string): TerminalLeaf => ({ type: "leaf", id });

  it("getLeaves returns leaves in DFS order", () => {
    const { result } = renderHook(() => useTerminalState(1));
    act(() => result.current.togglePanel());
    const firstId = result.current.panes[0].id;
    act(() => result.current.splitPane(firstId, "horizontal"));
    const secondId = result.current.panes[1].id;
    act(() => result.current.splitPane(secondId, "vertical"));

    const root = result.current.root!;
    const leaves = getLeaves(root);
    expect(leaves).toHaveLength(3);
    expect(leaves[0].id).toBe(firstId);
    expect(leaves[1].id).toBe(secondId);
  });

  describe("findAdjacentLeaf", () => {
    it("returns null for a single leaf (no neighbors)", () => {
      const root = leaf("A");
      expect(findAdjacentLeaf(root, "A", "left")).toBeNull();
      expect(findAdjacentLeaf(root, "A", "right")).toBeNull();
      expect(findAdjacentLeaf(root, "A", "up")).toBeNull();
      expect(findAdjacentLeaf(root, "A", "down")).toBeNull();
    });

    it("navigates left/right in a horizontal split", () => {
      // [A | B]
      const root: SplitNode = {
        type: "split",
        orientation: "horizontal",
        children: [leaf("A"), leaf("B")],
      };
      expect(findAdjacentLeaf(root, "A", "right")).toBe("B");
      expect(findAdjacentLeaf(root, "B", "left")).toBe("A");
      expect(findAdjacentLeaf(root, "A", "left")).toBeNull();
      expect(findAdjacentLeaf(root, "B", "right")).toBeNull();
    });

    it("navigates up/down in a vertical split", () => {
      // [A / B] (top/bottom)
      const root: SplitNode = {
        type: "split",
        orientation: "vertical",
        children: [leaf("A"), leaf("B")],
      };
      expect(findAdjacentLeaf(root, "A", "down")).toBe("B");
      expect(findAdjacentLeaf(root, "B", "up")).toBe("A");
      expect(findAdjacentLeaf(root, "A", "up")).toBeNull();
      expect(findAdjacentLeaf(root, "B", "down")).toBeNull();
    });

    it("does not navigate across wrong axis", () => {
      const root: SplitNode = {
        type: "split",
        orientation: "horizontal",
        children: [leaf("A"), leaf("B")],
      };
      expect(findAdjacentLeaf(root, "A", "up")).toBeNull();
      expect(findAdjacentLeaf(root, "A", "down")).toBeNull();
    });

    it("navigates in mixed layout (horizontal root, vertical right child)", () => {
      // [A | [B / C]]
      const root: SplitNode = {
        type: "split",
        orientation: "horizontal",
        children: [
          leaf("A"),
          { type: "split", orientation: "vertical", children: [leaf("B"), leaf("C")] },
        ],
      };
      // Left/right across the horizontal split
      expect(findAdjacentLeaf(root, "A", "right")).toBe("B"); // nearest edge leaf
      expect(findAdjacentLeaf(root, "B", "left")).toBe("A");
      expect(findAdjacentLeaf(root, "C", "left")).toBe("A");
      // Up/down within the vertical split
      expect(findAdjacentLeaf(root, "B", "down")).toBe("C");
      expect(findAdjacentLeaf(root, "C", "up")).toBe("B");
      // No vertical neighbor for A
      expect(findAdjacentLeaf(root, "A", "up")).toBeNull();
      expect(findAdjacentLeaf(root, "A", "down")).toBeNull();
    });

    it("navigates in deeply nested layout", () => {
      // [[A / B] | [C / D]]
      const root: SplitNode = {
        type: "split",
        orientation: "horizontal",
        children: [
          { type: "split", orientation: "vertical", children: [leaf("A"), leaf("B")] },
          { type: "split", orientation: "vertical", children: [leaf("C"), leaf("D")] },
        ],
      };
      // Horizontal navigation picks nearest edge leaf
      expect(findAdjacentLeaf(root, "A", "right")).toBe("C");
      expect(findAdjacentLeaf(root, "B", "right")).toBe("C");
      expect(findAdjacentLeaf(root, "C", "left")).toBe("A");
      expect(findAdjacentLeaf(root, "D", "left")).toBe("A");
      // Vertical within each column
      expect(findAdjacentLeaf(root, "A", "down")).toBe("B");
      expect(findAdjacentLeaf(root, "C", "down")).toBe("D");
    });

    it("returns null for unknown leaf id", () => {
      const root: SplitNode = {
        type: "split",
        orientation: "horizontal",
        children: [leaf("A"), leaf("B")],
      };
      expect(findAdjacentLeaf(root, "Z", "left")).toBeNull();
    });
  });
});
