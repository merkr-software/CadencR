/**
 * Single source of truth for every user-visible keyboard shortcut.
 *
 * Each entry mirrors a real `useHotkeys` / `useScopedHotkeys` /
 * `useGlobalShortcut` registration somewhere in the codebase. If you add a
 * new shortcut, add it here too — the in-app Keyboard Shortcuts modal
 * (⌘/) renders straight from this list, so anything missing here is
 * effectively undocumented.
 *
 * `keys` is the platform-agnostic combo. Use the literal tokens below; the
 * formatter in `format.ts` turns them into ⌘/⌃/⌥/⇧ on macOS or
 * Ctrl/Alt/Shift on other platforms.
 */
export type ShortcutKey =
  | "mod" // ⌘ on macOS, Ctrl elsewhere
  | "ctrl" // literal Control (vim-style ^J etc.)
  | "alt" // ⌥ on macOS, Alt elsewhere
  | "shift"
  | "enter"
  | "escape"
  | "tab"
  | "space"
  | "up"
  | "down"
  | "left"
  | "right"
  | "plus"
  | "minus"
  | "comma"
  | "slash"
  | "backtick"
  | "lbracket"
  | "rbracket"
  // Letter / digit / single-char literals are passed through verbatim.
  | (string & {});

/**
 * `as const` so each entry's literal `id` is preserved — `ShortcutScopeId` is
 * derived from the array below, keeping the union and the runtime list as
 * one source of truth.
 */
export const SHORTCUT_SCOPES = [
  { id: "global", label: "Global", hint: "Work anywhere in Cadencr." },
  { id: "settings", label: "Settings", hint: "When the settings page is open." },
  { id: "sidebar", label: "Sidebar", hint: "When the project tree has focus." },
  { id: "unified-agents", label: "Unified Agents", hint: "On the /agents grid view." },
  {
    id: "feature-panes",
    label: "Feature panes",
    hint: "Inside a feature workspace — switches between Agent / Editor / Terminal / Git tabs.",
  },
  {
    id: "feature",
    label: "Feature actions",
    hint: "Inside a feature workspace — header buttons and labels.",
  },
  { id: "agent", label: "Agent & prompt", hint: "When the Agent tab is focused." },
  { id: "plan-approval", label: "Plan approval", hint: "While a plan-approval bar is showing." },
  {
    id: "permission-prompt",
    label: "Tool permission",
    hint: "While the agent is asking permission to run a tool.",
  },
  {
    id: "question-drawer",
    label: "Agent questions",
    hint: "While the agent is asking a multiple-choice question.",
  },
  { id: "diff-viewer", label: "Diff viewer", hint: "When the Git tab is focused." },
  { id: "editor", label: "Editor", hint: "When the Editor tab has focus." },
  { id: "terminal", label: "Terminal", hint: "When the Terminal tab has focus." },
] as const;

export type ShortcutScope = (typeof SHORTCUT_SCOPES)[number];
export type ShortcutScopeId = ShortcutScope["id"];

export interface Shortcut {
  id: string;
  keys: ShortcutKey[];
  /** Alternate combo, for shortcuts that intentionally bind two combos to the same action. */
  altKeys?: ShortcutKey[];
  description: string;
  scope: ShortcutScopeId;
  /** Search-only synonyms (e.g. "quit", "exit" for ⌘Q). Never rendered. */
  aliases?: string[];
}

/**
 * Canonical list. Order within a scope is the order rendered.
 *
 * `as const satisfies` keeps the literal `id` of every entry so the
 * `ShortcutId` union below is derived from this single source — typos in
 * `useShortcut("comand-palette", …)` become compile errors.
 */
export const SHORTCUTS = [
  // ─── Global ──────────────────────────────────────────────────────────
  {
    id: "command-palette",
    keys: ["mod", "k"],
    description: "Open command palette",
    scope: "global",
  },
  { id: "open-settings", keys: ["mod", "comma"], description: "Open settings", scope: "global" },
  { id: "toggle-sidebar", keys: ["mod", "b"], description: "Toggle sidebar", scope: "global" },
  { id: "new-session", keys: ["mod", "shift", "n"], description: "New session", scope: "global" },
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
    id: "shortcuts-help",
    keys: ["mod", "slash"],
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
    id: "pane-editor",
    keys: ["mod", "shift", "e"],
    description: "Editor tab",
    scope: "feature-panes",
  },

  // ─── Feature actions ─────────────────────────────────────────────────
  {
    id: "feature-settings",
    keys: ["mod", "shift", "p"],
    altKeys: ["alt", "p"],
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
  {
    id: "branch-picker",
    keys: ["mod", "b"],
    description: "Toggle branch picker",
    scope: "feature",
    aliases: ["checkout"],
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

  // ─── Editor ──────────────────────────────────────────────────────────
  { id: "editor-fuzzy", keys: ["mod", "p"], description: "Fuzzy file search", scope: "editor" },
  { id: "editor-close", keys: ["mod", "w"], description: "Close buffer", scope: "editor" },
  {
    id: "editor-next-tab",
    keys: ["mod", "shift", "rbracket"],
    description: "Next file tab",
    scope: "editor",
  },
  {
    id: "editor-prev-tab",
    keys: ["mod", "shift", "lbracket"],
    description: "Previous file tab",
    scope: "editor",
  },
  {
    id: "editor-split-v",
    keys: ["mod", "d"],
    description: "Split pane vertically",
    scope: "editor",
  },
  {
    id: "editor-split-h",
    keys: ["mod", "shift", "d"],
    description: "Split pane horizontally",
    scope: "editor",
  },
  {
    id: "editor-nav-pane-left",
    keys: ["mod", "alt", "left"],
    description: "Focus pane left",
    scope: "editor",
  },
  {
    id: "editor-nav-pane-right",
    keys: ["mod", "alt", "right"],
    description: "Focus pane right",
    scope: "editor",
  },
  {
    id: "editor-nav-pane-up",
    keys: ["mod", "alt", "up"],
    description: "Focus pane up",
    scope: "editor",
  },
  {
    id: "editor-nav-pane-down",
    keys: ["mod", "alt", "down"],
    description: "Focus pane down",
    scope: "editor",
  },

  // ─── Terminal ────────────────────────────────────────────────────────
  {
    id: "terminal-focus",
    keys: ["mod", "t"],
    description: "Focus or open terminal",
    scope: "terminal",
  },
  {
    id: "terminal-split-h",
    keys: ["mod", "d"],
    description: "Split horizontal",
    scope: "terminal",
  },
  {
    id: "terminal-split-v",
    keys: ["mod", "shift", "d"],
    description: "Split vertical",
    scope: "terminal",
  },
  {
    id: "terminal-nav-pane-left",
    keys: ["mod", "alt", "left"],
    description: "Focus pane left",
    scope: "terminal",
  },
  {
    id: "terminal-nav-pane-right",
    keys: ["mod", "alt", "right"],
    description: "Focus pane right",
    scope: "terminal",
  },
  {
    id: "terminal-nav-pane-up",
    keys: ["mod", "alt", "up"],
    description: "Focus pane up",
    scope: "terminal",
  },
  {
    id: "terminal-nav-pane-down",
    keys: ["mod", "alt", "down"],
    description: "Focus pane down",
    scope: "terminal",
  },
  { id: "terminal-close", keys: ["mod", "w"], description: "Close pane", scope: "terminal" },
] as const satisfies readonly Shortcut[];

export type ShortcutId = (typeof SHORTCUTS)[number]["id"];

/**
 * Duplicate-id check. Combo collisions within a scope (e.g. ⌘⏎ for both
 * `agent-send` and `agent-maximize`) are tolerated — they're deliberate
 * focus-dependent dual purposes — but two entries sharing an `id` would
 * make the resolver pick whichever appears first. Dev-only so a bad PR
 * fails CI rather than shipping silent ambiguity; tree-shaken in prod.
 */
if (import.meta.env.DEV) {
  const seen = new Set<string>();
  for (const s of SHORTCUTS) {
    if (seen.has(s.id)) {
      throw new Error(`Duplicate shortcut id "${s.id}" in lib/shortcuts/registry.ts`);
    }
    seen.add(s.id);
  }
}

/** Indexed view used by the modal — computed once at module load since the
 *  underlying registry is static. */
export const SHORTCUTS_BY_SCOPE: ReadonlyArray<{ scope: ShortcutScope; items: Shortcut[] }> =
  SHORTCUT_SCOPES.map((scope) => ({
    scope,
    items: SHORTCUTS.filter((s) => s.scope === scope.id),
  })).filter((g) => g.items.length > 0);

/** Total shortcut count — also constant, used by the modal's "n of N" badge. */
export const TOTAL_SHORTCUTS = SHORTCUTS_BY_SCOPE.reduce((acc, g) => acc + g.items.length, 0);
