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

type LabelTranslator = (key: string, defaultValue: string) => string;

interface PaletteShortcutMeta {
  title: (t: LabelTranslator) => string;
  group: PaletteCommandGroup;
  keywords?: readonly string[];
}

export const PALETTE_SHORTCUT_COMMANDS = {
  "navigate-back": {
    title: (t) => t("palette.shortcuts.navigate-back", "Go back"),
    group: "Navigate",
    keywords: ["history", "previous"],
  },
  "navigate-forward": {
    title: (t) => t("palette.shortcuts.navigate-forward", "Go forward"),
    group: "Navigate",
    keywords: ["history", "next"],
  },
  "toggle-sidebar": {
    title: (t) => t("palette.shortcuts.toggle-sidebar", "Toggle sidebar"),
    group: "View",
    keywords: ["hide", "show", "panel"],
  },
  "zoom-in": {
    title: (t) => t("palette.shortcuts.zoom-in", "Zoom in"),
    group: "View",
    keywords: ["bigger", "font", "scale"],
  },
  "zoom-out": {
    title: (t) => t("palette.shortcuts.zoom-out", "Zoom out"),
    group: "View",
    keywords: ["smaller", "font", "scale"],
  },
  "zoom-reset": {
    title: (t) => t("palette.shortcuts.zoom-reset", "Reset zoom"),
    group: "View",
    keywords: ["actual size", "100%"],
  },
  "shortcuts-help": {
    title: (t) => t("palette.shortcuts.shortcuts-help", "Keyboard shortcuts"),
    group: "View",
    keywords: ["help", "cheatsheet", "keys", "hotkeys"],
  },
  "stop-all-agents": {
    title: (t) => t("palette.shortcuts.stop-all-agents", "Stop all running agents"),
    group: "Agent",
    keywords: ["interrupt", "cancel", "halt", "kill"],
  },
  "delete-feature": {
    title: (t) => t("palette.shortcuts.delete-feature", "Archive conversation…"),
    group: "Conversation",
    keywords: ["delete", "remove", "close", "done"],
  },
  "edit-label": {
    title: (t) => t("palette.shortcuts.edit-label", "Edit label…"),
    group: "Conversation",
    keywords: ["tag", "status"],
  },
  "feature-settings": {
    title: (t) => t("palette.shortcuts.feature-settings", "Conversation settings…"),
    group: "Conversation",
    keywords: ["worktree", "branch", "preferences"],
  },
  "for-me-done": {
    title: (t) => t("palette.shortcuts.for-me-done", "Mark as done"),
    group: "Conversation",
    keywords: ["for me", "handled", "dismiss", "review"],
  },
  "content-search": {
    title: (t) => t("palette.shortcuts.content-search", "Search in files…"),
    group: "Conversation",
    keywords: ["grep", "find", "content", "text", "ripgrep"],
  },
  "pane-agent": {
    title: (t) => t("palette.shortcuts.pane-agent", "Show Agent tab"),
    group: "Conversation",
    keywords: ["chat", "pane"],
  },
  "pane-terminal": {
    title: (t) => t("palette.shortcuts.pane-terminal", "Show Terminal tab"),
    group: "Conversation",
    keywords: ["shell", "pane"],
  },
  "pane-git": {
    title: (t) => t("palette.shortcuts.pane-git", "Show Git tab"),
    group: "Conversation",
    keywords: ["diff", "changes", "pane"],
  },
  "pane-editor": {
    title: (t) => t("palette.shortcuts.pane-editor", "Show Editor tab"),
    group: "Conversation",
    keywords: ["code", "files", "pane"],
  },
  "pane-browser": {
    title: (t) => t("palette.shortcuts.pane-browser", "Show Browser tab"),
    group: "Conversation",
    keywords: ["web", "preview", "pane"],
  },
  "layout-auto-toggle": {
    title: (t) => t("palette.shortcuts.layout-auto-toggle", "Toggle auto layout"),
    group: "View",
    keywords: ["split", "panes", "reveal"],
  },
  "conversation-search": {
    title: (t) => t("palette.shortcuts.conversation-search", "Find in conversation…"),
    group: "Conversation",
    keywords: ["search", "transcript", "messages"],
  },
  "git-actions": {
    title: (t) => t("palette.shortcuts.git-actions", "Git actions…"),
    group: "Git",
    keywords: ["git", "menu"],
  },
  "custom-actions": {
    title: (t) => t("palette.shortcuts.custom-actions", "Custom actions…"),
    group: "Conversation",
    keywords: ["run", "task", "script", "command", "runs"],
  },
  "git-commit": {
    title: (t) => t("palette.shortcuts.git-commit", "Commit…"),
    group: "Git",
    keywords: ["git", "save", "stage"],
  },
  "git-push": {
    title: (t) => t("palette.shortcuts.git-push", "Push…"),
    group: "Git",
    keywords: ["git", "upload", "remote"],
  },
  "git-pr": {
    title: (t) => t("palette.shortcuts.git-pr", "Create pull request…"),
    group: "Git",
    keywords: ["git", "pr", "compare", "merge request", "review"],
  },
  "agent-model-picker": {
    title: (t) => t("palette.shortcuts.agent-model-picker", "Change model…"),
    group: "Agent",
    keywords: ["provider", "claude", "codex", "llm"],
  },
  "agent-permission-mode": {
    title: (t) => t("palette.shortcuts.agent-permission-mode", "Cycle permission mode"),
    group: "Agent",
    keywords: ["plan", "auto", "accept edits", "bypass"],
  },
} satisfies Partial<Record<ShortcutId, PaletteShortcutMeta>>;

export type PaletteShortcutId = keyof typeof PALETTE_SHORTCUT_COMMANDS;

export function isPaletteShortcut(id: ShortcutId): id is PaletteShortcutId {
  return Object.hasOwn(PALETTE_SHORTCUT_COMMANDS, id);
}

export function paletteCommandGroupLabel(group: PaletteCommandGroup, t: LabelTranslator): string {
  switch (group) {
    case "Navigate":
      return t("palette.groups.navigate", "Navigate");
    case "Create":
      return t("palette.groups.create", "Create");
    case "Conversation":
      return t("palette.groups.conversation", "Conversation");
    case "Git":
      return t("palette.groups.git", "Git");
    case "Agent":
      return t("palette.groups.agent", "Agent");
    case "View":
      return t("palette.groups.view", "View");
    case "Settings":
      return t("palette.groups.settings", "Settings");
  }
}
