/**
 * Editor + editor-buffer shortcut entries. Extracted from `entries.ts` to
 * keep the canonical file under the 400-line limit; merged back in the
 * combined `SHORTCUTS` array exported from `entries.ts`.
 */
import type { Shortcut } from "./types";

export const EDITOR_SHORTCUTS = [
  // ─── Editor ──────────────────────────────────────────────────────────
  {
    id: "editor-fuzzy",
    keys: ["mod", "p"],
    describe(t) {
      return t("shortcuts.descriptions.editor-fuzzy", "Fuzzy file search");
    },
    scope: "editor",
  },
  {
    id: "editor-new",
    keys: ["mod", "n"],
    describe(t) {
      return t("shortcuts.descriptions.editor-new", "New buffer");
    },
    scope: "editor",
  },
  {
    // ⌘S is also bound inside CodeMirror's keymap (see
    // `BaseCodeMirrorEditor.tsx`) so the in-editor binding stays
    // self-contained. The registry entry makes the chord discoverable
    // in the cheatsheet and respects user remapping.
    id: "editor-save",
    keys: ["mod", "s"],
    describe(t) {
      return t("shortcuts.descriptions.editor-save", "Save");
    },
    scope: "editor",
  },
  {
    id: "editor-buffer-search",
    keys: ["mod", "f"],
    describe(t) {
      return t("shortcuts.descriptions.editor-buffer-search", "Find in current file");
    },
    scope: "editor",
  },
  {
    // ⌘⌥F is "Replace…" — VS Code uses the same chord. ⌘F stays plain find;
    // ⌘G is taken globally by the Git actions popover so we cannot use it
    // for "find next" the way some IDEs do.
    id: "editor-replace",
    keys: ["mod", "alt", "f"],
    describe(t) {
      return t("shortcuts.descriptions.editor-replace", "Replace in current file");
    },
    scope: "editor",
  },
  {
    // ⌃G mirrors classic IDE "Go to line" (Sublime / Vim-ish). ⌘L is taken
    // elsewhere; we keep ⌘⌥G as a discoverable alias.
    id: "editor-go-to-line",
    keys: ["ctrl", "g"],
    altKeys: ["mod", "alt", "g"],
    describe(t) {
      return t("shortcuts.descriptions.editor-go-to-line", "Go to line");
    },
    scope: "editor",
  },
  {
    id: "editor-toggle-sidebar",
    keys: ["mod", "e"],
    describe(t) {
      return t("shortcuts.descriptions.editor-toggle-sidebar", "Toggle explorer");
    },
    scope: "editor",
  },
  {
    id: "editor-close",
    keys: ["mod", "w"],
    describe(t) {
      return t("shortcuts.descriptions.editor-close", "Close buffer");
    },
    scope: "editor",
  },
  {
    // ⌘⇧C — copy the active file's project-relative path (same value as the
    // tab context-menu "Copy Path"). Capture-phase + editor-scoped so it
    // fires even when focus is inside the CodeMirror buffer.
    id: "editor-copy-path",
    keys: ["mod", "shift", "c"],
    describe(t) {
      return t("shortcuts.descriptions.editor-copy-path", "Copy file path");
    },
    scope: "editor",
  },
  {
    // Generic preview toggle — fires for markdown, HTML, SVG, and CSV / TSV files.
    // The editor decides per-file whether the chord is enabled and what
    // the preview surface renders (see `getPreviewKind`).
    id: "editor-toggle-preview",
    keys: ["mod", "m"],
    describe(t) {
      return t("shortcuts.descriptions.editor-toggle-preview", "Toggle preview");
    },
    scope: "editor",
  },
  {
    id: "editor-language-confirm",
    keys: ["mod", "enter"],
    describe(t) {
      return t("shortcuts.descriptions.editor-language-confirm", "Apply language selection");
    },
    scope: "editor",
  },
  {
    id: "editor-language-toggle-extension",
    keys: ["a"],
    describe(t) {
      return t(
        "shortcuts.descriptions.editor-language-toggle-extension",
        "Toggle language selection for file extension",
      );
    },
    scope: "editor",
  },
  {
    id: "editor-next-tab",
    keys: ["mod", "shift", "rbracket"],
    describe(t) {
      return t("shortcuts.descriptions.editor-next-tab", "Next file tab");
    },
    scope: "editor",
  },
  {
    id: "editor-prev-tab",
    keys: ["mod", "shift", "lbracket"],
    describe(t) {
      return t("shortcuts.descriptions.editor-prev-tab", "Previous file tab");
    },
    scope: "editor",
  },
  {
    id: "editor-nav-pane-left",
    keys: ["mod", "alt", "left"],
    describe(t) {
      return t("shortcuts.descriptions.editor-nav-pane-left", "Focus pane left");
    },
    scope: "editor",
  },
  {
    id: "editor-nav-pane-right",
    keys: ["mod", "alt", "right"],
    describe(t) {
      return t("shortcuts.descriptions.editor-nav-pane-right", "Focus pane right");
    },
    scope: "editor",
  },
  {
    id: "editor-nav-pane-up",
    keys: ["mod", "alt", "up"],
    describe(t) {
      return t("shortcuts.descriptions.editor-nav-pane-up", "Focus pane up");
    },
    scope: "editor",
  },
  {
    id: "editor-nav-pane-down",
    keys: ["mod", "alt", "down"],
    describe(t) {
      return t("shortcuts.descriptions.editor-nav-pane-down", "Focus pane down");
    },
    scope: "editor",
  },

  // ─── Editor buffer (CodeMirror file buffer focus) ────────────────────
  // These chords fire only when keyboard focus is inside `.cm-editor`.
  // They appear in the cheatsheet for discoverability but are routed
  // through CodeMirror's keymap rather than a global hotkey listener.
  {
    id: "editor-trigger-completion",
    keys: ["ctrl", "space"],
    describe(t) {
      return t("shortcuts.descriptions.editor-trigger-completion", "Trigger completion");
    },
    scope: "editor-buffer",
  },
  {
    id: "editor-toggle-line-comment",
    keys: ["mod", "slash"],
    describe(t) {
      return t("shortcuts.descriptions.editor-toggle-line-comment", "Toggle line comment");
    },
    scope: "editor-buffer",
  },
  {
    // ⌘K — "Delete line" (VS Code / Sublime convention) while focus is in
    // the CodeMirror buffer. The global command palette also lives on ⌘K,
    // but its root handler defers to the editor here via
    // `isInCodeMirrorEditor`, so the buffer keymap wins when focused.
    id: "editor-delete-line",
    keys: ["mod", "k"],
    describe(t) {
      return t("shortcuts.descriptions.editor-delete-line", "Delete line");
    },
    scope: "editor-buffer",
  },
  {
    id: "editor-select-next-occurrence",
    keys: ["mod", "d"],
    describe(t) {
      return t(
        "shortcuts.descriptions.editor-select-next-occurrence",
        "Add selection to next occurrence",
      );
    },
    scope: "editor-buffer",
  },
  {
    id: "editor-select-all-occurrences",
    keys: ["mod", "shift", "l"],
    describe(t) {
      return t("shortcuts.descriptions.editor-select-all-occurrences", "Select all occurrences");
    },
    scope: "editor-buffer",
  },
  {
    id: "editor-add-cursor-above",
    keys: ["mod", "alt", "up"],
    describe(t) {
      return t("shortcuts.descriptions.editor-add-cursor-above", "Add cursor above");
    },
    scope: "editor-buffer",
  },
  {
    id: "editor-add-cursor-below",
    keys: ["mod", "alt", "down"],
    describe(t) {
      return t("shortcuts.descriptions.editor-add-cursor-below", "Add cursor below");
    },
    scope: "editor-buffer",
  },
  {
    id: "editor-fold-region",
    keys: ["mod", "alt", "lbracket"],
    altKeys: ["ctrl", "shift", "lbracket"],
    describe(t) {
      return t("shortcuts.descriptions.editor-fold-region", "Fold region");
    },
    scope: "editor-buffer",
  },
  {
    id: "editor-unfold-region",
    keys: ["mod", "alt", "rbracket"],
    altKeys: ["ctrl", "shift", "rbracket"],
    describe(t) {
      return t("shortcuts.descriptions.editor-unfold-region", "Unfold region");
    },
    scope: "editor-buffer",
  },
  {
    id: "editor-indent",
    keys: ["tab"],
    describe(t) {
      return t("shortcuts.descriptions.editor-indent", "Indent selection");
    },
    scope: "editor-buffer",
  },
  {
    id: "editor-outdent",
    keys: ["shift", "tab"],
    describe(t) {
      return t("shortcuts.descriptions.editor-outdent", "Outdent selection");
    },
    scope: "editor-buffer",
  },
  {
    id: "editor-rename-symbol",
    keys: ["f2"],
    describe(t) {
      return t("shortcuts.descriptions.editor-rename-symbol", "Rename symbol");
    },
    scope: "editor-buffer",
  },
  {
    // ⇧F12 — classic IDE "Find all references" (VS Code uses the same chord).
    id: "editor-find-references",
    keys: ["shift", "f12"],
    describe(t) {
      return t("shortcuts.descriptions.editor-find-references", "Find all references");
    },
    scope: "editor-buffer",
  },
  {
    // ⌘⇧O — "Go to symbol in file" (VS Code convention). Editor-scoped +
    // capture-phase so it wins over the feature-level ⌘⇧O (Open PR) while the
    // editor tab is focused.
    id: "editor-symbol-outline",
    keys: ["mod", "shift", "o"],
    describe(t) {
      return t("shortcuts.descriptions.editor-symbol-outline", "Go to symbol in file");
    },
    scope: "editor-buffer",
  },
  {
    // ⌘T — "Go to symbol in workspace" (VS Code convention). Editor-scoped so
    // it doesn't clash with the agent tab's ⌘T (cycle thinking effort).
    id: "editor-workspace-symbols",
    keys: ["mod", "t"],
    describe(t) {
      return t("shortcuts.descriptions.editor-workspace-symbols", "Go to symbol in workspace");
    },
    scope: "editor-buffer",
  },
  {
    // ⌘⇧I — "Format document" (VS Code's alternate chord; we avoid VS Code's
    // default ⇧⌥F because ⌥+letter triggers a macOS dead key). Runs the
    // project's configured formatter. Capture-phase so it fires while focus
    // is inside the CodeMirror buffer.
    id: "editor-format-document",
    keys: ["mod", "shift", "i"],
    describe(t) {
      return t("shortcuts.descriptions.editor-format-document", "Format document");
    },
    scope: "editor-buffer",
  },
  {
    // Same chord as the Terminal's: "hand this to the agent". Lands in the
    // conversation composer's context tray, not sent.
    id: "editor-add-selection-to-prompt",
    keys: ["mod", "shift", "enter"],
    describe(t) {
      return t(
        "shortcuts.descriptions.editor-add-selection-to-prompt",
        "Add selection to the agent prompt",
      );
    },
    scope: "editor",
    aliases: ["context", "agent", "prompt"],
  },
] as const satisfies readonly Shortcut[];
