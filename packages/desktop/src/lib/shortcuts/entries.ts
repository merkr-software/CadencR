/**
 * Canonical shortcut list. Each entry mirrors a real `useHotkeys` /
 * `useScopedHotkeys` / `useGlobalShortcut` registration somewhere in the
 * codebase. If you add a new shortcut, add it here too — the in-app
 * Keyboard Shortcuts modal (⌘⇧?) renders straight from this list, so
 * anything missing here is effectively undocumented.
 *
 * `keys` is the platform-agnostic combo. Use the literal tokens from
 * `ShortcutKey`; the formatter in `format.ts` turns them into ⌘/⌃/⌥/⇧ on
 * macOS or Ctrl/Alt/Shift on other platforms.
 *
 * Order within a scope is the order rendered. Editor + editor-buffer
 * entries live in {@link ./entries-editor} to keep this file under the
 * 400-line limit; they are concatenated below.
 *
 * `as const satisfies` keeps the literal `id` of every entry so the
 * `ShortcutId` union below is derived from this single source — typos in
 * `useShortcut("comand-palette", …)` become compile errors.
 */
import type { Shortcut } from "./types";
import { BROWSER_SHORTCUTS } from "./entries-browser";
import { EDITOR_SHORTCUTS } from "./entries-editor";
import { TERMINAL_SHORTCUTS } from "./entries-terminal";

const APP_SHORTCUTS = [
  // ─── Global ──────────────────────────────────────────────────────────
  {
    // ⌘K — the global command-palette / "search everything" chord, matching
    // Linear / Slack / Raycast. It also drives the sidebar Search button.
    // ⌘⇧P is deliberately NOT used here: that chord is the unified-agents
    // "Pin / unpin" local shortcut (`agents-pin`). Inside the CodeMirror
    // buffer ⌘K stays "Delete line" — the root handler defers to the editor
    // via `isInCodeMirrorEditor`.
    id: "command-palette",
    keys: ["mod", "k"],
    description: "Open command palette",
    scope: "global",
  },
  { id: "open-settings", keys: ["mod", "comma"], description: "Open settings", scope: "global" },
  { id: "toggle-sidebar", keys: ["mod", "b"], description: "Toggle sidebar", scope: "global" },
  { id: "new-session", keys: ["mod", "shift", "n"], description: "New session", scope: "feature" },
  {
    id: "delete-feature",
    keys: ["mod", "shift", "x"],
    description: "Archive (or delete archived) feature",
    scope: "global",
  },
  {
    id: "stop-all-agents",
    keys: ["mod", "escape"],
    description: "Stop all running agents",
    scope: "global",
  },
  {
    id: "open-unified-agents",
    keys: ["mod", "shift", "r"],
    description: "Open unified agents view",
    scope: "global",
  },
  {
    id: "content-search",
    keys: ["mod", "shift", "f"],
    description: "Open content search in this feature",
    scope: "global",
  },
  {
    id: "quit",
    keys: ["mod", "q"],
    description: "Quit Cadencr",
    scope: "global",
    aliases: ["exit"],
  },
  {
    // Renderer-side fallback for ⌘W / Ctrl+W. Fires only when the focused
    // tab's owning surface has nothing to close — the editor-close /
    // terminal-close scoped handlers take ⌘W on their tabs when buffers /
    // panes exist there. Scoping the bypass to the focused surface (not
    // the whole feature) lets ⌘W close the window on an empty editor even
    // when a terminal pane is open elsewhere in the same feature.
    //
    // ⌘W is deliberately NOT an Electron menu accelerator: a menu
    // accelerator intercepts the chord at the AppKit level before the
    // editor/terminal handlers ever see it, breaking close-the-tab.
    id: "app-close",
    keys: ["mod", "w"],
    description: "Close window",
    scope: "global",
  },
  { id: "zoom-in", keys: ["mod", "plus"], description: "Zoom in", scope: "global" },
  { id: "zoom-out", keys: ["mod", "minus"], description: "Zoom out", scope: "global" },
  { id: "zoom-reset", keys: ["mod", "0"], description: "Reset zoom", scope: "global" },
  {
    // ⌘⇧? — distinct from plain ⌘/ which is the CodeMirror "Toggle Line
    // Comment" binding inside the editor.
    //
    // The `question` token is expanded by the binding layer
    // (`lib/shortcuts/character-hotkeys.ts`) into a layout-robust set of
    // `event.key` matches: `?`, plus the `/` (QWERTY) and `,` (AZERTY) base
    // chars that macOS reports for the `?` key while Cmd is held. That keeps
    // the help modal reachable across layouts without any `altKeys` here.
    id: "shortcuts-help",
    keys: ["mod", "shift", "question"],
    description: "Show keyboard shortcuts",
    scope: "global",
    aliases: ["help", "cheatsheet"],
  },

  // ─── Settings ────────────────────────────────────────────────────────
  { id: "settings-back", keys: ["escape"], description: "Back to workspace", scope: "settings" },

  // ─── Sidebar ─────────────────────────────────────────────────────────
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

  // ─── Unified Agents ──────────────────────────────────────────────────
  {
    id: "agents-search",
    keys: ["mod", "shift", "f"],
    description: "Focus agents search",
    scope: "unified-agents",
  },
  {
    id: "agents-pin",
    keys: ["mod", "shift", "p"],
    description: "Pin / unpin active agent",
    scope: "unified-agents",
  },
  {
    id: "agents-hide",
    keys: ["mod", "shift", "h"],
    description: "Hide active agent from this view",
    scope: "unified-agents",
  },
  {
    id: "agents-navigate-left",
    keys: ["mod", "alt", "left"],
    description: "Move selection left",
    scope: "unified-agents",
  },
  {
    id: "agents-navigate-right",
    keys: ["mod", "alt", "right"],
    description: "Move selection right",
    scope: "unified-agents",
  },
  {
    id: "agents-navigate-up",
    keys: ["mod", "alt", "up"],
    description: "Move selection up",
    scope: "unified-agents",
  },
  {
    id: "agents-navigate-down",
    keys: ["mod", "alt", "down"],
    description: "Move selection down",
    scope: "unified-agents",
  },
  {
    id: "agents-open-feature",
    keys: ["mod", "shift", "o"],
    description: "Open active agent's feature page",
    scope: "unified-agents",
  },
  {
    id: "agents-new-feature",
    keys: ["mod", "shift", "n"],
    description: "New session (pick a project)",
    scope: "unified-agents",
  },

  // ─── Feature panes ───────────────────────────────────────────────────
  {
    id: "pane-agent",
    keys: ["mod", "shift", "a"],
    description: "Agent tab",
    scope: "feature-panes",
  },
  {
    id: "pane-terminal",
    keys: ["mod", "shift", "t"],
    description: "Terminal tab",
    scope: "feature-panes",
  },
  { id: "pane-git", keys: ["mod", "shift", "g"], description: "Git tab", scope: "feature-panes" },
  {
    id: "pane-browser",
    keys: ["mod", "shift", "b"],
    description: "Browser tab",
    scope: "feature-panes",
  },
  {
    id: "pane-editor",
    keys: ["mod", "shift", "e"],
    description: "Editor tab",
    scope: "feature-panes",
  },

  // ─── Feature actions ─────────────────────────────────────────────────
  {
    // Lives on ⌥P only. (⌘⇧P is the unified-agents pin shortcut; the global
    // command palette is on ⌘K.)
    id: "feature-settings",
    keys: ["alt", "p"],
    description: "Feature settings popover",
    scope: "feature",
  },
  {
    id: "edit-label",
    keys: ["mod", "shift", "l"],
    description: "Edit feature label",
    scope: "feature",
  },
  {
    id: "git-actions",
    keys: ["mod", "g"],
    description: "Git actions popover",
    scope: "feature",
  },
  {
    id: "git-commit",
    keys: ["mod", "shift", "k"],
    description: "Open commit dialog",
    scope: "feature",
  },
  {
    id: "git-push",
    keys: ["mod", "shift", "u"],
    description: "Open push dialog",
    scope: "feature",
  },
  {
    id: "git-pr",
    keys: ["mod", "shift", "o"],
    description: "Open compare / PR dialog",
    scope: "feature",
  },

  // ─── Agent & prompt ──────────────────────────────────────────────────
  {
    id: "agent-model-picker",
    keys: ["mod", "p"],
    description: "Open model picker",
    scope: "agent",
  },
  {
    id: "agent-thinking",
    keys: ["mod", "t"],
    description: "Cycle thinking effort",
    scope: "agent",
  },
  {
    // ⌘F / Ctrl+F — find-in-conversation. Bound capture-phase in the `agent`
    // scope so it intercepts before the prompt editor; the editor tab keeps
    // its own ⌘F ("Find in current file") because that's a different scope.
    id: "conversation-search",
    keys: ["mod", "f"],
    description: "Find in conversation",
    scope: "agent",
    aliases: ["search", "find"],
  },
  { id: "agent-send", keys: ["mod", "enter"], description: "Send message", scope: "agent" },
  { id: "agent-maximize", keys: ["mod", "enter"], description: "Maximize agent", scope: "agent" },
  {
    id: "agent-collapse",
    keys: ["mod", "shift", "z"],
    description: "Collapse agent",
    scope: "agent",
  },
  {
    id: "agent-permission-mode",
    keys: ["shift", "tab"],
    description: "Cycle permission mode",
    scope: "agent",
  },
  {
    id: "agent-autoscroll",
    keys: ["mod", "shift", "s"],
    description: "Re-enable auto-scroll",
    scope: "agent",
  },
  { id: "agent-stop", keys: ["escape"], description: "Stop running agent", scope: "agent" },

  // ─── Plan approval ───────────────────────────────────────────────────
  { id: "plan-approve", keys: ["mod", "y"], description: "Approve plan", scope: "plan-approval" },
  {
    id: "plan-feedback",
    keys: ["mod", "n"],
    description: "Request plan changes (feedback)",
    scope: "plan-approval",
  },
  { id: "plan-reject", keys: ["escape"], description: "Reject plan", scope: "plan-approval" },

  // ─── Tool permission prompt ──────────────────────────────────────────
  {
    id: "perm-allow-once",
    keys: ["mod", "y"],
    description: "Allow once",
    scope: "permission-prompt",
  },
  {
    id: "perm-allow-future",
    keys: ["mod", "l"],
    description: "Allow for the rest of session",
    scope: "permission-prompt",
  },
  { id: "perm-deny", keys: ["mod", "n"], description: "Deny", scope: "permission-prompt" },

  // ─── Question drawer ─────────────────────────────────────────────────
  { id: "q-select-1-9", keys: ["1-9"], description: "Select option", scope: "question-drawer" },
  { id: "q-other", keys: ["mod", "o"], description: 'Toggle "Other…"', scope: "question-drawer" },
  {
    id: "q-submit",
    keys: ["enter"],
    description: "Submit / next question",
    scope: "question-drawer",
  },
  { id: "q-prev", keys: ["left"], description: "Previous question", scope: "question-drawer" },
  { id: "q-next", keys: ["right"], description: "Next question", scope: "question-drawer" },

  // ─── Diff viewer ─────────────────────────────────────────────────────
  { id: "diff-next-file", keys: ["ctrl", "j"], description: "Next file", scope: "diff-viewer" },
  { id: "diff-prev-file", keys: ["ctrl", "k"], description: "Previous file", scope: "diff-viewer" },
  { id: "diff-toggle-file", keys: ["ctrl", "l"], description: "Toggle file", scope: "diff-viewer" },
  {
    id: "diff-scroll-down",
    keys: ["ctrl", "d"],
    description: "Scroll half-page down",
    scope: "diff-viewer",
  },
  {
    id: "diff-scroll-up",
    keys: ["ctrl", "u"],
    description: "Scroll half-page up",
    scope: "diff-viewer",
  },
  {
    id: "diff-mark-viewed",
    keys: ["ctrl", "h"],
    description: "Mark file viewed / unviewed",
    scope: "diff-viewer",
  },
  {
    id: "diff-toggle-sidebar",
    keys: ["mod", "e"],
    description: "Toggle Git file list",
    scope: "diff-viewer",
  },
  {
    id: "diff-send-comments",
    keys: ["mod", "enter"],
    description: "Send pending comments",
    scope: "diff-viewer",
  },
  {
    id: "diff-open-focused-file",
    keys: ["mod", "o"],
    description: "Open focused file in editor",
    scope: "diff-viewer",
  },
] as const satisfies readonly Shortcut[];

export const SHORTCUTS = [
  ...APP_SHORTCUTS,
  ...TERMINAL_SHORTCUTS,
  ...EDITOR_SHORTCUTS,
  ...BROWSER_SHORTCUTS,
] as const;

export type ShortcutId = (typeof SHORTCUTS)[number]["id"];
