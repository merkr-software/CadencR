import type { Shortcut } from "./types";

export const APP_SHORTCUTS = [
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
    describe(t) {
      return t("shortcuts.descriptions.command-palette", "Open command palette");
    },
    scope: "global",
  },
  {
    id: "open-settings",
    keys: ["mod", "comma"],
    describe(t) {
      return t("shortcuts.descriptions.open-settings", "Open settings");
    },
    scope: "global",
  },
  {
    id: "toggle-sidebar",
    keys: ["mod", "b"],
    describe(t) {
      return t("shortcuts.descriptions.toggle-sidebar", "Toggle sidebar");
    },
    scope: "global",
  },
  {
    id: "navigate-back",
    keys: ["mod", "lbracket"],
    describe(t) {
      return t("shortcuts.descriptions.navigate-back", "Go back");
    },
    scope: "global",
  },
  {
    id: "navigate-forward",
    keys: ["mod", "rbracket"],
    describe(t) {
      return t("shortcuts.descriptions.navigate-forward", "Go forward");
    },
    scope: "global",
  },
  {
    id: "new-session",
    keys: ["mod", "shift", "n"],
    describe(t) {
      return t("shortcuts.descriptions.new-session", "New session");
    },
    scope: "feature",
  },
  {
    id: "delete-feature",
    keys: ["mod", "shift", "x"],
    describe(t) {
      return t("shortcuts.descriptions.delete-feature", "Archive (or delete archived) feature");
    },
    scope: "global",
  },
  {
    id: "stop-all-agents",
    keys: ["mod", "escape"],
    describe(t) {
      return t("shortcuts.descriptions.stop-all-agents", "Stop all running agents");
    },
    scope: "global",
  },
  {
    id: "open-unified-agents",
    keys: ["mod", "shift", "r"],
    describe(t) {
      return t("shortcuts.descriptions.open-unified-agents", "Open unified agents view");
    },
    scope: "global",
  },
  {
    // ⌘⇧Y, chosen because every mnemonic candidate is taken: ⇧S is
    // `agent-autoscroll`, ⇧T/⇧L are pane chords. Y is free in every scope.
    id: "open-schedules",
    keys: ["mod", "shift", "y"],
    describe(t) {
      return t("shortcuts.descriptions.open-schedules", "Open schedules");
    },
    scope: "global",
  },
  {
    id: "content-search",
    keys: ["mod", "shift", "f"],
    describe(t) {
      return t("shortcuts.descriptions.content-search", "Open content search in this feature");
    },
    scope: "global",
  },
  {
    id: "quit",
    keys: ["mod", "q"],
    describe(t) {
      return t("shortcuts.descriptions.quit", "Quit Cadencr");
    },
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
    describe(t) {
      return t("shortcuts.descriptions.app-close", "Close window");
    },
    scope: "global",
  },
  {
    id: "zoom-in",
    keys: ["mod", "plus"],
    describe(t) {
      return t("shortcuts.descriptions.zoom-in", "Zoom in");
    },
    scope: "global",
  },
  {
    id: "zoom-out",
    keys: ["mod", "minus"],
    describe(t) {
      return t("shortcuts.descriptions.zoom-out", "Zoom out");
    },
    scope: "global",
  },
  {
    id: "zoom-reset",
    keys: ["mod", "0"],
    describe(t) {
      return t("shortcuts.descriptions.zoom-reset", "Reset zoom");
    },
    scope: "global",
  },
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
    describe(t) {
      return t("shortcuts.descriptions.shortcuts-help", "Show keyboard shortcuts");
    },
    scope: "global",
    aliases: ["help", "cheatsheet"],
  },
  // ─── Settings ────────────────────────────────────────────────────────
  {
    id: "settings-back",
    keys: ["escape"],
    describe(t) {
      return t(
        "shortcuts.descriptions.settings-back",
        "Clear the settings search, else back to workspace",
      );
    },
    scope: "settings",
  },
  {
    id: "settings-search",
    keys: ["mod", "f"],
    describe(t) {
      return t("shortcuts.descriptions.settings-search", "Search settings");
    },
    scope: "settings",
    aliases: ["find"],
  },
  // ─── Unified Agents ──────────────────────────────────────────────────
  {
    id: "agents-search",
    keys: ["mod", "shift", "f"],
    describe(t) {
      return t("shortcuts.descriptions.agents-search", "Focus agents search");
    },
    scope: "unified-agents",
  },
  {
    id: "agents-pin",
    keys: ["mod", "shift", "p"],
    describe(t) {
      return t("shortcuts.descriptions.agents-pin", "Pin / unpin active agent");
    },
    scope: "unified-agents",
  },
  {
    id: "agents-hide",
    keys: ["mod", "shift", "h"],
    describe(t) {
      return t("shortcuts.descriptions.agents-hide", "Hide active agent from this view");
    },
    scope: "unified-agents",
  },
  {
    id: "agents-navigate-left",
    keys: ["mod", "alt", "left"],
    describe(t) {
      return t("shortcuts.descriptions.agents-navigate-left", "Move selection left");
    },
    scope: "unified-agents",
  },
  {
    id: "agents-navigate-right",
    keys: ["mod", "alt", "right"],
    describe(t) {
      return t("shortcuts.descriptions.agents-navigate-right", "Move selection right");
    },
    scope: "unified-agents",
  },
  {
    id: "agents-navigate-up",
    keys: ["mod", "alt", "up"],
    describe(t) {
      return t("shortcuts.descriptions.agents-navigate-up", "Move selection up");
    },
    scope: "unified-agents",
  },
  {
    id: "agents-navigate-down",
    keys: ["mod", "alt", "down"],
    describe(t) {
      return t("shortcuts.descriptions.agents-navigate-down", "Move selection down");
    },
    scope: "unified-agents",
  },
  {
    id: "agents-open-feature",
    keys: ["mod", "shift", "o"],
    describe(t) {
      return t("shortcuts.descriptions.agents-open-feature", "Open active agent's feature page");
    },
    scope: "unified-agents",
  },
  {
    id: "agents-new-feature",
    keys: ["mod", "shift", "n"],
    describe(t) {
      return t("shortcuts.descriptions.agents-new-feature", "New session (pick a project)");
    },
    scope: "unified-agents",
  },
  // ─── Feature panes ───────────────────────────────────────────────────
  {
    id: "pane-agent",
    keys: ["mod", "shift", "a"],
    describe(t) {
      return t("shortcuts.descriptions.pane-agent", "Agent tab");
    },
    scope: "feature-panes",
  },
  {
    id: "pane-terminal",
    keys: ["mod", "shift", "t"],
    describe(t) {
      return t("shortcuts.descriptions.pane-terminal", "Terminal tab");
    },
    scope: "feature-panes",
  },
  {
    id: "pane-git",
    keys: ["mod", "shift", "g"],
    describe(t) {
      return t("shortcuts.descriptions.pane-git", "Git tab");
    },
    scope: "feature-panes",
  },
  {
    id: "pane-browser",
    keys: ["mod", "shift", "b"],
    describe(t) {
      return t("shortcuts.descriptions.pane-browser", "Browser tab");
    },
    scope: "feature-panes",
  },
  {
    id: "pane-editor",
    keys: ["mod", "shift", "e"],
    describe(t) {
      return t("shortcuts.descriptions.pane-editor", "Editor tab");
    },
    scope: "feature-panes",
  },
  {
    // ⌘⌥B: every free ⌘⇧ letter is taken, and B sits beside the Browser tab's
    // ⌘⇧B — auto layout's headline move is splitting the Browser in. Off macOS
    // this is Ctrl+Alt+B (an AltGr chord), and no common layout composes a
    // character on AltGr+B. Cmd suppresses Option's composition on macOS.
    id: "layout-auto-toggle",
    keys: ["mod", "alt", "b"],
    describe(t) {
      return t("shortcuts.descriptions.layout-auto-toggle", "Toggle auto layout");
    },
    scope: "feature-panes",
    aliases: ["auto layout", "split"],
  },
  // ─── Feature actions ─────────────────────────────────────────────────
  {
    // Lives on ⌥P only. (⌘⇧P is the unified-agents pin shortcut; the global
    // command palette is on ⌘K.)
    id: "feature-settings",
    keys: ["alt", "p"],
    describe(t) {
      return t("shortcuts.descriptions.feature-settings", "Feature settings popover");
    },
    scope: "feature",
  },
  {
    id: "edit-label",
    keys: ["mod", "shift", "l"],
    describe(t) {
      return t("shortcuts.descriptions.edit-label", "Edit feature label");
    },
    scope: "feature",
  },
  {
    id: "git-actions",
    keys: ["mod", "g"],
    describe(t) {
      return t("shortcuts.descriptions.git-actions", "Git actions popover");
    },
    scope: "feature",
  },
  {
    id: "custom-actions",
    keys: ["mod", "alt", "r"],
    describe(t) {
      return t("shortcuts.descriptions.custom-actions", "Custom actions menu");
    },
    scope: "feature",
    aliases: ["run", "task", "script", "command"],
  },
  {
    id: "custom-action-run-1-9",
    keys: ["mod", "alt", "1-9"],
    describe(t) {
      return t("shortcuts.descriptions.custom-action-run-1-9", "Run custom action 1–9");
    },
    scope: "feature",
    aliases: ["run", "task", "script", "command"],
  },
  {
    id: "git-commit",
    keys: ["mod", "shift", "k"],
    describe(t) {
      return t("shortcuts.descriptions.git-commit", "Open commit dialog");
    },
    scope: "feature",
  },
  {
    id: "git-push",
    keys: ["mod", "shift", "u"],
    describe(t) {
      return t("shortcuts.descriptions.git-push", "Open push dialog");
    },
    scope: "feature",
  },
  {
    id: "git-pr",
    keys: ["mod", "shift", "o"],
    describe(t) {
      return t("shortcuts.descriptions.git-pr", "Open compare / pull request dialog");
    },
    scope: "feature",
  },
] as const satisfies readonly Shortcut[];
