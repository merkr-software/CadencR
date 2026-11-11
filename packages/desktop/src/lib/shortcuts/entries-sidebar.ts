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
    description: "Next action for me",
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
    description: "Answer the newest request",
    scope: "global",
    aliases: ["for me", "pending", "approval", "permission", "question", "quick reply"],
  },
  {
    id: "attention-next-unread",
    keys: ["mod", "alt", "j"],
    description: "Next unread conversation",
    scope: "global",
    aliases: ["for me", "inbox"],
  },
  {
    // ⌥⌘↩ — "confirm": the focused row's For me entry, else the open
    // conversation's, leaves the list (and its pull request action stays
    // dismissed until the pull request moves). Fires from the composer too.
    id: "for-me-done",
    keys: ["mod", "alt", "enter"],
    description: "Mark done for me",
    scope: "global",
    aliases: ["for me", "done", "acknowledge", "dismiss", "inbox"],
  },
  {
    id: "sidebar-focus-down",
    keys: ["mod", "alt", "down"],
    description: "Move focus down",
    scope: "sidebar",
  },
  {
    id: "sidebar-focus-up",
    keys: ["mod", "alt", "up"],
    description: "Move focus up",
    scope: "sidebar",
  },
  {
    id: "sidebar-activate",
    keys: ["enter"],
    description: "Open focused item",
    scope: "sidebar",
  },
  {
    id: "sidebar-row-pin",
    keys: ["mod", "alt", "p"],
    description: "Pin / unpin the focused conversation",
    scope: "sidebar",
  },
  {
    id: "sidebar-row-archive",
    keys: ["mod", "backspace"],
    description: "Archive the focused conversation",
    scope: "sidebar",
  },
  {
    id: "sidebar-row-rename",
    keys: ["f2"],
    description: "Rename the focused conversation",
    scope: "sidebar",
  },
  {
    id: "sidebar-row-label",
    keys: ["mod", "alt", "l"],
    description: "Set the focused conversation's label",
    scope: "sidebar",
  },
  {
    id: "sidebar-row-toggle-unread",
    keys: ["mod", "alt", "u"],
    description: "Mark the focused conversation read / unread",
    scope: "sidebar",
  },
  {
    // Focus moves with ⌥⌘↑/↓; Shift carries the focused row along instead.
    // One step within its group (project, worktree, parent, lens group); at
    // the group's edge nothing happens. The first move switches to Manual.
    id: "sidebar-reorder-up",
    keys: ["mod", "alt", "shift", "up"],
    description: "Move the focused conversation up",
    scope: "sidebar",
    aliases: ["reorder", "manual order", "drag"],
  },
  {
    id: "sidebar-reorder-down",
    keys: ["mod", "alt", "shift", "down"],
    description: "Move the focused conversation down",
    scope: "sidebar",
    aliases: ["reorder", "manual order", "drag"],
  },
] as const satisfies readonly Shortcut[];
