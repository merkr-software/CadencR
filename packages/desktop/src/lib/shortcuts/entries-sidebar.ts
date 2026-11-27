import type { Shortcut } from "./types";

/**
 * Sidebar shortcuts: moving through the tree, acting on the focused
 * conversation row, and jumping to the next thing that needs you.
 * The row actions only fire while a conversation row has focus, so they can
 * reuse chords other scopes bind (⌘⌫ is the terminal's delete-line, F2 the
 * editor's rename symbol); printable keys stay free for type-to-filter.
 */
export const SIDEBAR_SHORTCUTS = [
  {
    // ⌘J — "jump" to the next action in the "For me" list, in its order:
    // pending requests, failed turns, blocked pull requests, finished turns,
    // merges — cycling from the open conversation.
    id: "attention-next-needs-you",
    keys: ["mod", "j"],
    describe(t) {
      return t("shortcuts.descriptions.attention-next-needs-you", "Next action for me");
    },
    scope: "global",
    aliases: ["for me", "next action", "pending", "approval", "pull request", "inbox"],
  },
  {
    // ⌥⌘A — "answer": opens the newest pending permission or question as a
    // quick reply (a popover beside its row, a sheet on a phone), focus inside.
    // Plans are read in their conversation, so they are skipped. ⌘⇧A is the
    // Agent tab's.
    id: "answer-newest-request",
    keys: ["mod", "alt", "a"],
    describe(t) {
      return t("shortcuts.descriptions.answer-newest-request", "Answer the newest request");
    },
    scope: "global",
    aliases: ["for me", "pending", "approval", "permission", "question", "quick reply"],
  },
  {
    id: "attention-next-unread",
    keys: ["mod", "alt", "j"],
    describe(t) {
      return t("shortcuts.descriptions.attention-next-unread", "Next unread conversation");
    },
    scope: "global",
    aliases: ["for me", "inbox"],
  },
  {
    // ⌥⌘↩ — "confirm": the focused row's For me entry, else the open
    // conversation's, leaves the list (and its pull request action stays
    // dismissed until the pull request moves). Fires from the composer too.
    id: "for-me-done",
    keys: ["mod", "alt", "enter"],
    describe(t) {
      return t("shortcuts.descriptions.for-me-done", "Mark done for me");
    },
    scope: "global",
    aliases: ["for me", "done", "acknowledge", "dismiss", "inbox"],
  },
  {
    id: "sidebar-focus-down",
    keys: ["mod", "alt", "down"],
    describe(t) {
      return t("shortcuts.descriptions.sidebar-focus-down", "Move focus down");
    },
    scope: "sidebar",
  },
  {
    id: "sidebar-focus-up",
    keys: ["mod", "alt", "up"],
    describe(t) {
      return t("shortcuts.descriptions.sidebar-focus-up", "Move focus up");
    },
    scope: "sidebar",
  },
  {
    id: "sidebar-activate",
    keys: ["enter"],
    describe(t) {
      return t("shortcuts.descriptions.sidebar-activate", "Open focused item");
    },
    scope: "sidebar",
  },
  {
    id: "sidebar-row-pin",
    keys: ["mod", "alt", "p"],
    describe(t) {
      return t("shortcuts.descriptions.sidebar-row-pin", "Pin / unpin the focused conversation");
    },
    scope: "sidebar",
  },
  {
    id: "sidebar-row-archive",
    keys: ["mod", "backspace"],
    describe(t) {
      return t("shortcuts.descriptions.sidebar-row-archive", "Archive the focused conversation");
    },
    scope: "sidebar",
  },
  {
    id: "sidebar-row-rename",
    keys: ["f2"],
    describe(t) {
      return t("shortcuts.descriptions.sidebar-row-rename", "Rename the focused conversation");
    },
    scope: "sidebar",
  },
  {
    id: "sidebar-row-label",
    keys: ["mod", "alt", "l"],
    describe(t) {
      return t("shortcuts.descriptions.sidebar-row-label", "Set the focused conversation's label");
    },
    scope: "sidebar",
  },
  {
    id: "sidebar-row-toggle-unread",
    keys: ["mod", "alt", "u"],
    describe(t) {
      return t(
        "shortcuts.descriptions.sidebar-row-toggle-unread",
        "Mark the focused conversation read / unread",
      );
    },
    scope: "sidebar",
  },
  {
    // Focus moves with ⌥⌘↑/↓; Shift carries the focused row along instead.
    // One step within its group (project, worktree, parent, lens group); at
    // the group's edge nothing happens. The first move switches to Manual.
    id: "sidebar-reorder-up",
    keys: ["mod", "alt", "shift", "up"],
    describe(t) {
      return t("shortcuts.descriptions.sidebar-reorder-up", "Move the focused conversation up");
    },
    scope: "sidebar",
    aliases: ["reorder", "manual order", "drag"],
  },
  {
    id: "sidebar-reorder-down",
    keys: ["mod", "alt", "shift", "down"],
    describe(t) {
      return t("shortcuts.descriptions.sidebar-reorder-down", "Move the focused conversation down");
    },
    scope: "sidebar",
    aliases: ["reorder", "manual order", "drag"],
  },
] as const satisfies readonly Shortcut[];
