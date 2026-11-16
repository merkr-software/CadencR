import type { ShortcutId } from "@/lib/shortcuts/registry";

/**
 * Shortcuts the palette offers as commands, with the palette's own wording.
 * Only these register their handler (see `useShortcutPaletteAction`); the rest
 * (navigation inside a list, vim chords, answers to a prompt) make no sense
 * out of context. Titles end with "…" when they open something to fill in.
 */

export type PaletteCommandGroup =
  | "Navigate"
  | "Create"
  | "Conversation"
  | "Git"
  | "Agent"
  | "View"
  | "Settings";

export interface PaletteShortcutMeta {
  title: string;
  group: PaletteCommandGroup;
  keywords?: readonly string[];
}

export const PALETTE_SHORTCUT_COMMANDS = {
  "navigate-back": { title: "Go back", group: "Navigate", keywords: ["history", "previous"] },
  "navigate-forward": { title: "Go forward", group: "Navigate", keywords: ["history", "next"] },
  "toggle-sidebar": { title: "Toggle sidebar", group: "View", keywords: ["hide", "show", "panel"] },
  "zoom-in": { title: "Zoom in", group: "View", keywords: ["bigger", "font", "scale"] },
  "zoom-out": { title: "Zoom out", group: "View", keywords: ["smaller", "font", "scale"] },
  "zoom-reset": { title: "Reset zoom", group: "View", keywords: ["actual size", "100%"] },
  "shortcuts-help": {
    title: "Keyboard shortcuts",
    group: "View",
    keywords: ["help", "cheatsheet", "keys", "hotkeys"],
  },
  "stop-all-agents": {
    title: "Stop all running agents",
    group: "Agent",
    keywords: ["interrupt", "cancel", "halt", "kill"],
  },
  "delete-feature": {
    title: "Archive conversation…",
    group: "Conversation",
    keywords: ["delete", "remove", "close", "done"],
  },
  "edit-label": { title: "Edit label…", group: "Conversation", keywords: ["tag", "status"] },
  "feature-settings": {
    title: "Conversation settings…",
    group: "Conversation",
    keywords: ["worktree", "branch", "preferences"],
  },
  "for-me-done": {
    title: "Mark as done",
    group: "Conversation",
    keywords: ["for me", "handled", "dismiss", "review"],
  },
  "content-search": {
    title: "Search in files…",
    group: "Conversation",
    keywords: ["grep", "find", "content", "text", "ripgrep"],
  },
  "pane-agent": { title: "Show Agent tab", group: "Conversation", keywords: ["chat", "pane"] },
  "pane-terminal": {
    title: "Show Terminal tab",
    group: "Conversation",
    keywords: ["shell", "pane"],
  },
  "pane-git": {
    title: "Show Git tab",
    group: "Conversation",
    keywords: ["diff", "changes", "pane"],
  },
  "pane-editor": {
    title: "Show Editor tab",
    group: "Conversation",
    keywords: ["code", "files", "pane"],
  },
  "pane-browser": {
    title: "Show Browser tab",
    group: "Conversation",
    keywords: ["web", "preview", "pane"],
  },
  "layout-auto-toggle": {
    title: "Toggle auto layout",
    group: "View",
    keywords: ["split", "panes", "reveal"],
  },
  "conversation-search": {
    title: "Find in conversation…",
    group: "Conversation",
    keywords: ["search", "transcript", "messages"],
  },
  "git-actions": { title: "Git actions…", group: "Git", keywords: ["git", "menu"] },
  "custom-actions": {
    title: "Custom actions…",
    group: "Conversation",
    keywords: ["run", "task", "script", "command", "runs"],
  },
  "git-commit": { title: "Commit…", group: "Git", keywords: ["git", "save", "stage"] },
  "git-push": { title: "Push…", group: "Git", keywords: ["git", "upload", "remote"] },
  "git-pr": {
    title: "Create pull request…",
    group: "Git",
    keywords: ["git", "pr", "compare", "merge request", "review"],
  },
  "agent-model-picker": {
    title: "Change model…",
    group: "Agent",
    keywords: ["provider", "claude", "codex", "llm"],
  },
  "agent-permission-mode": {
    title: "Cycle permission mode",
    group: "Agent",
    keywords: ["plan", "auto", "accept edits", "bypass"],
  },
} satisfies Partial<Record<ShortcutId, PaletteShortcutMeta>>;

export type PaletteShortcutId = keyof typeof PALETTE_SHORTCUT_COMMANDS;

export function isPaletteShortcut(id: ShortcutId): id is PaletteShortcutId {
  return Object.hasOwn(PALETTE_SHORTCUT_COMMANDS, id);
}
