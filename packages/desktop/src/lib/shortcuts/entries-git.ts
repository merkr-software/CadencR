import type { Shortcut } from "./types";

export const GIT_SHORTCUTS = [
  {
    id: "git-next-item",
    keys: ["j"],
    describe(t) {
      return t("shortcuts.descriptions.git-next-item", "Next Git item");
    },
    scope: "diff-viewer",
    aliases: ["git", "next file"],
  },
  {
    id: "git-previous-item",
    keys: ["k"],
    describe(t) {
      return t("shortcuts.descriptions.git-previous-item", "Previous Git item");
    },
    scope: "diff-viewer",
    aliases: ["git", "previous file"],
  },
  {
    id: "git-open-item",
    keys: ["l"],
    describe(t) {
      return t("shortcuts.descriptions.git-open-item", "Open or expand Git item");
    },
    scope: "diff-viewer",
    aliases: ["git", "expand file"],
  },
  {
    id: "git-back",
    keys: ["h"],
    describe(t) {
      return t("shortcuts.descriptions.git-back", "Collapse or go back in Git");
    },
    scope: "diff-viewer",
    aliases: ["git", "back"],
  },
  {
    id: "git-scroll-down",
    keys: ["d"],
    describe(t) {
      return t("shortcuts.descriptions.git-scroll-down", "Scroll Git half-page down");
    },
    scope: "diff-viewer",
    aliases: ["git"],
  },
  {
    id: "git-scroll-up",
    keys: ["u"],
    describe(t) {
      return t("shortcuts.descriptions.git-scroll-up", "Scroll Git half-page up");
    },
    scope: "diff-viewer",
    aliases: ["git"],
  },
  {
    id: "git-toggle-viewed",
    keys: ["v"],
    describe(t) {
      return t("shortcuts.descriptions.git-toggle-viewed", "Toggle selected Git file viewed");
    },
    scope: "diff-viewer",
    aliases: ["git", "reviewed"],
  },
  {
    id: "git-stage-file",
    keys: ["s"],
    describe(t) {
      return t("shortcuts.descriptions.git-stage-file", "Stage selected Git file");
    },
    scope: "diff-viewer",
    aliases: ["git", "add"],
  },
  {
    // `x` is the select-a-row key every forge's own inbox uses, and it is the
    // one bare letter the Git navigation map had left. It picks the *focused*
    // thread, so it composes with j/k into a keyboard-only path from "read the
    // review" to "hand it to the agent" without touching a checkbox.
    id: "git-toggle-thread-picked",
    keys: ["x"],
    describe(t) {
      return t(
        "shortcuts.descriptions.git-toggle-thread-picked",
        "Pick or unpick the focused review thread",
      );
    },
    scope: "diff-viewer",
    aliases: ["git", "review", "select", "pull request", "merge request"],
  },
  {
    id: "git-reset-file",
    keys: ["r"],
    describe(t) {
      return t(
        "shortcuts.descriptions.git-reset-file",
        "Unstage selected Git file (preserve worktree)",
      );
    },
    scope: "diff-viewer",
    aliases: ["git", "reset"],
  },
  {
    id: "diff-toggle-sidebar",
    keys: ["mod", "e"],
    describe(t) {
      return t("shortcuts.descriptions.diff-toggle-sidebar", "Toggle Git file list");
    },
    scope: "diff-viewer",
    aliases: ["git", "sidebar"],
  },
  {
    id: "diff-send-comments",
    keys: ["mod", "enter"],
    describe(t) {
      return t(
        "shortcuts.descriptions.diff-send-comments",
        "Send local Git comments or review feedback",
      );
    },
    scope: "diff-viewer",
    aliases: ["git", "review"],
  },
  {
    id: "diff-send-review-comments",
    keys: ["mod", "shift", "enter"],
    describe(t) {
      return t("shortcuts.descriptions.diff-send-review-comments", "Send selected review feedback");
    },
    scope: "diff-viewer",
    aliases: ["git", "review", "pull request", "merge request"],
  },
  {
    id: "git-next-review-thread",
    keys: ["mod", "shift", "j"],
    describe(t) {
      return t("shortcuts.descriptions.git-next-review-thread", "Jump to next open review thread");
    },
    scope: "diff-viewer",
    aliases: ["git", "review", "next"],
  },
  {
    id: "git-previous-review-thread",
    keys: ["mod", "shift", "k"],
    describe(t) {
      return t(
        "shortcuts.descriptions.git-previous-review-thread",
        "Jump to previous open review thread",
      );
    },
    scope: "diff-viewer",
    aliases: ["git", "review", "previous"],
  },
  {
    id: "git-open-in-editor",
    keys: ["mod", "o"],
    describe(t) {
      return t("shortcuts.descriptions.git-open-in-editor", "Open selected Git file in Editor");
    },
    scope: "diff-viewer",
    aliases: ["git", "edit"],
  },
  {
    id: "git-show-uncommitted",
    keys: ["mod", "u"],
    describe(t) {
      return t("shortcuts.descriptions.git-show-uncommitted", "Show Git Uncommitted");
    },
    scope: "diff-viewer",
    aliases: ["git", "changes", "working tree"],
  },
  {
    id: "git-show-vs-target",
    keys: ["mod", "t"],
    describe(t) {
      return t("shortcuts.descriptions.git-show-vs-target", "Show Git vs Target");
    },
    scope: "diff-viewer",
    aliases: ["git", "compare", "target"],
  },
  {
    // ⌘P joins the rest of the ⌘-letter Git view family. It collides with the
    // editor's fuzzy-find and the agent's model picker by combo, but those live
    // in different scopes — same deliberate overlap as ⌘T (vs-target /
    // thinking effort) and ⌘S (stashes / save).
    id: "git-show-pull-request",
    keys: ["mod", "p"],
    describe(t) {
      return t(
        "shortcuts.descriptions.git-show-pull-request",
        "Show pull request or merge request",
      );
    },
    scope: "diff-viewer",
    aliases: ["git", "review", "pull request", "merge request"],
  },
  {
    // ⌘Y for "histor**y**". Not ⌘H: that is the system-wide Hide role on
    // macOS, which the window manager claims before the renderer ever sees
    // the keydown, so the binding could never fire there. ⌘Y is redo on
    // Windows/Linux and collides with `plan-approve` / `perm-allow-once`, but
    // all three are scope-gated: this one only binds while the diff viewer has
    // focus, where neither redo nor an approval prompt is reachable.
    id: "git-show-commits",
    keys: ["mod", "y"],
    describe(t) {
      return t("shortcuts.descriptions.git-show-commits", "Show Git Commits");
    },
    scope: "diff-viewer",
    aliases: ["git", "history", "graph"],
  },
  {
    id: "git-show-branches",
    keys: ["mod", "l"],
    describe(t) {
      return t("shortcuts.descriptions.git-show-branches", "Show Git Branches");
    },
    scope: "diff-viewer",
    aliases: ["git", "branch"],
  },
  {
    id: "git-show-stashes",
    keys: ["mod", "s"],
    describe(t) {
      return t("shortcuts.descriptions.git-show-stashes", "Show Git Stashes");
    },
    scope: "diff-viewer",
    aliases: ["git", "stash"],
  },
] as const satisfies readonly Shortcut[];
