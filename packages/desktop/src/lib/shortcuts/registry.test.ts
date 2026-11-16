import { describe, expect, it } from "vitest";
import { SHORTCUTS } from "./registry";

function shortcutKeys(id: string): string[] {
  const shortcut = SHORTCUTS.find((entry) => entry.id === id);
  if (!shortcut) throw new Error(`Shortcut not found: ${id}`);
  return shortcut.keys;
}

describe("shortcut registry", () => {
  it("keeps unified-agent open-feature on mod+shift+o so Git can use mod+o", () => {
    expect(shortcutKeys("agents-open-feature")).toEqual(["mod", "shift", "o"]);
    expect(shortcutKeys("git-open-in-editor")).toEqual(["mod", "o"]);
  });

  it("registers the approved bare-key Git navigation map", () => {
    expect({
      next: shortcutKeys("git-next-item"),
      previous: shortcutKeys("git-previous-item"),
      open: shortcutKeys("git-open-item"),
      back: shortcutKeys("git-back"),
      viewed: shortcutKeys("git-toggle-viewed"),
      picked: shortcutKeys("git-toggle-thread-picked"),
      stage: shortcutKeys("git-stage-file"),
      reset: shortcutKeys("git-reset-file"),
      down: shortcutKeys("git-scroll-down"),
      up: shortcutKeys("git-scroll-up"),
    }).toEqual({
      next: ["j"],
      previous: ["k"],
      open: ["l"],
      back: ["h"],
      viewed: ["v"],
      // `x` is the select-a-row key every forge inbox uses, and the one bare
      // letter this map had left.
      picked: ["x"],
      stage: ["s"],
      reset: ["r"],
      down: ["d"],
      up: ["u"],
    });
  });

  it("registers the approved persisted Git view map", () => {
    expect({
      uncommitted: shortcutKeys("git-show-uncommitted"),
      target: shortcutKeys("git-show-vs-target"),
      pullRequest: shortcutKeys("git-show-pull-request"),
      commits: shortcutKeys("git-show-commits"),
      branches: shortcutKeys("git-show-branches"),
      stashes: shortcutKeys("git-show-stashes"),
    }).toEqual({
      uncommitted: ["mod", "u"],
      target: ["mod", "t"],
      pullRequest: ["mod", "p"],
      commits: ["mod", "y"],
      branches: ["mod", "l"],
      stashes: ["mod", "s"],
    });
  });

  it("keeps local drafts and remote review feedback on explicit Git chords", () => {
    expect(shortcutKeys("diff-send-comments")).toEqual(["mod", "enter"]);
    expect(shortcutKeys("diff-send-review-comments")).toEqual(["mod", "shift", "enter"]);
    expect(shortcutKeys("git-next-review-thread")).toEqual(["mod", "shift", "j"]);
    expect(shortcutKeys("git-previous-review-thread")).toEqual(["mod", "shift", "k"]);
  });

  it("removes the superseded Ctrl-based diff shortcut identifiers", () => {
    const ids = new Set(SHORTCUTS.map((shortcut) => shortcut.id));
    expect(ids).not.toContain("diff-next-file");
    expect(ids).not.toContain("diff-prev-file");
    expect(ids).not.toContain("diff-toggle-file");
    expect(ids).not.toContain("diff-scroll-down");
    expect(ids).not.toContain("diff-scroll-up");
    expect(ids).not.toContain("diff-mark-viewed");
    expect(ids).not.toContain("diff-open-focused-file");
  });

  it("scopes new-session to feature pages and gives the agents view its own mod+shift+n", () => {
    const newSession = SHORTCUTS.find((s) => s.id === "new-session");
    const agentsNew = SHORTCUTS.find((s) => s.id === "agents-new-feature");
    expect(newSession?.scope).toBe("feature");
    expect(newSession?.keys).toEqual(["mod", "shift", "n"]);
    expect(agentsNew?.scope).toBe("unified-agents");
    expect(agentsNew?.keys).toEqual(["mod", "shift", "n"]);
  });

  it("registers find-in-conversation on mod+f in the agent scope", () => {
    const conversationSearch = SHORTCUTS.find((s) => s.id === "conversation-search");
    expect(conversationSearch?.keys).toEqual(["mod", "f"]);
    expect(conversationSearch?.scope).toBe("agent");
    // mod+f is shared with the editor's "find in current file" — a deliberate
    // cross-scope reuse, gated by which tab is focused. They must NOT collide
    // within the same scope.
    const editorSearch = SHORTCUTS.find((s) => s.id === "editor-buffer-search");
    expect(editorSearch?.keys).toEqual(["mod", "f"]);
    expect(editorSearch?.scope).not.toBe(conversationSearch?.scope);
  });

  it("binds the attention jumps globally and the row actions to the sidebar", () => {
    expect(shortcutKeys("attention-next-needs-you")).toEqual(["mod", "j"]);
    expect(shortcutKeys("attention-next-unread")).toEqual(["mod", "alt", "j"]);
    const rowActions = SHORTCUTS.filter((shortcut) => shortcut.id.startsWith("sidebar-row-"));
    expect(rowActions.map((shortcut) => shortcut.id)).toEqual([
      "sidebar-row-pin",
      "sidebar-row-archive",
      "sidebar-row-rename",
      "sidebar-row-label",
      "sidebar-row-toggle-unread",
    ]);
    expect(rowActions.every((shortcut) => shortcut.scope === "sidebar")).toBe(true);
    // No global chord may collide with them: a global binding would fire too.
    const globalChords = new Set(
      SHORTCUTS.filter((shortcut) => shortcut.scope === "global").map((s) => s.keys.join("+")),
    );
    for (const shortcut of rowActions)
      expect(globalChords.has(shortcut.keys.join("+"))).toBe(false);
  });
});

describe("answer-newest-request shortcut", () => {
  it("is global on a free chord (⌘⇧A is the Agent tab's)", () => {
    expect(shortcutKeys("answer-newest-request")).toEqual(["mod", "alt", "a"]);
    const chord = "mod+alt+a";
    const clashes = SHORTCUTS.filter(
      (shortcut) => shortcut.id !== "answer-newest-request" && shortcut.keys.join("+") === chord,
    );
    expect(clashes).toEqual([]);
    expect(SHORTCUTS.find((s) => s.id === "answer-newest-request")?.scope).toBe("global");
  });
});

describe("sidebar reorder shortcuts", () => {
  it("add Shift to the focus moves and collide with no global or sidebar chord", () => {
    expect(shortcutKeys("sidebar-reorder-up")).toEqual(["mod", "alt", "shift", "up"]);
    expect(shortcutKeys("sidebar-reorder-down")).toEqual(["mod", "alt", "shift", "down"]);
    for (const id of ["sidebar-reorder-up", "sidebar-reorder-down"]) {
      const chord = shortcutKeys(id).join("+");
      const clashes = SHORTCUTS.filter(
        (shortcut) =>
          shortcut.id !== id &&
          (shortcut.scope === "global" || shortcut.scope === "sidebar") &&
          shortcut.keys.join("+") === chord,
      );
      expect(clashes).toEqual([]);
    }
  });
});
