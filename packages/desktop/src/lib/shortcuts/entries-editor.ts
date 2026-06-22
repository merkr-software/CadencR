/**
 * Editor + editor-buffer shortcut entries. Extracted from `entries.ts` to
 * keep the canonical file under the 400-line limit; merged back in the
 * combined `SHORTCUTS` array exported from `entries.ts`.
 */
import type { Shortcut } from "./types";

export const EDITOR_SHORTCUTS = [
  // ─── Editor ──────────────────────────────────────────────────────────
  { id: "editor-fuzzy", keys: ["mod", "p"], description: "Fuzzy file search", scope: "editor" },
  { id: "editor-new", keys: ["mod", "n"], description: "New buffer", scope: "editor" },
  {
    // ⌘S is also bound inside CodeMirror's keymap (see
    // `BaseCodeMirrorEditor.tsx`) so the in-editor binding stays
    // self-contained. The registry entry makes the chord discoverable
    // in the cheatsheet and respects user remapping.
    id: "editor-save",
    keys: ["mod", "s"],
    description: "Save",
    scope: "editor",
  },
  {
    id: "editor-buffer-search",
    keys: ["mod", "f"],
    description: "Find in current file",
    scope: "editor",
  },
  {
    // ⌘⌥F is "Replace…" — VS Code uses the same chord. ⌘F stays plain find;
    // ⌘G is taken globally by the Git actions popover so we cannot use it
    // for "find next" the way some IDEs do.
    id: "editor-replace",
    keys: ["mod", "alt", "f"],
    description: "Replace in current file",
    scope: "editor",
  },
  {
    // ⌃G mirrors classic IDE "Go to line" (Sublime / Vim-ish). ⌘L is taken
    // elsewhere; we keep ⌘⌥G as a discoverable alias.
    id: "editor-go-to-line",
    keys: ["ctrl", "g"],
    altKeys: ["mod", "alt", "g"],
    description: "Go to line",
    scope: "editor",
  },
  {
    id: "editor-toggle-sidebar",
    keys: ["mod", "e"],
    description: "Toggle explorer",
    scope: "editor",
  },
  { id: "editor-close", keys: ["mod", "w"], description: "Close buffer", scope: "editor" },
  {
    // ⌘⇧C — copy the active file's project-relative path (same value as the
    // tab context-menu "Copy Path"). Capture-phase + editor-scoped so it
    // fires even when focus is inside the CodeMirror buffer.
    id: "editor-copy-path",
    keys: ["mod", "shift", "c"],
    description: "Copy file path",
    scope: "editor",
  },
  {
    // Generic preview toggle — fires for markdown, HTML, and SVG files.
    // The editor decides per-file whether the chord is enabled and what
    // the preview surface renders (see `getPreviewKind`).
    id: "editor-toggle-preview",
    keys: ["mod", "m"],
    description: "Toggle preview",
    scope: "editor",
  },
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

  // ─── Editor buffer (CodeMirror file buffer focus) ────────────────────
  // These chords fire only when keyboard focus is inside `.cm-editor`.
  // They appear in the cheatsheet for discoverability but are routed
  // through CodeMirror's keymap rather than a global hotkey listener.
  {
    id: "editor-trigger-completion",
    keys: ["ctrl", "space"],
    description: "Trigger completion",
    scope: "editor-buffer",
  },
  {
    id: "editor-toggle-line-comment",
    keys: ["mod", "slash"],
    description: "Toggle line comment",
    scope: "editor-buffer",
  },
  {
    // ⌘K — "Delete line" (VS Code / Sublime convention) while focus is in
    // the CodeMirror buffer. The global command palette also lives on ⌘K,
    // but its root handler defers to the editor here via
    // `isInCodeMirrorEditor`, so the buffer keymap wins when focused.
    id: "editor-delete-line",
    keys: ["mod", "k"],
    description: "Delete line",
    scope: "editor-buffer",
  },
  {
    id: "editor-select-next-occurrence",
    keys: ["mod", "d"],
    description: "Add selection to next occurrence",
    scope: "editor-buffer",
  },
  {
    id: "editor-select-all-occurrences",
    keys: ["mod", "shift", "l"],
    description: "Select all occurrences",
    scope: "editor-buffer",
  },
  {
    id: "editor-add-cursor-above",
    keys: ["mod", "alt", "up"],
    description: "Add cursor above",
    scope: "editor-buffer",
  },
  {
    id: "editor-add-cursor-below",
    keys: ["mod", "alt", "down"],
    description: "Add cursor below",
    scope: "editor-buffer",
  },
  {
    id: "editor-fold-region",
    keys: ["mod", "alt", "lbracket"],
    altKeys: ["ctrl", "shift", "lbracket"],
    description: "Fold region",
    scope: "editor-buffer",
  },
  {
    id: "editor-unfold-region",
    keys: ["mod", "alt", "rbracket"],
    altKeys: ["ctrl", "shift", "rbracket"],
    description: "Unfold region",
    scope: "editor-buffer",
  },
  {
    id: "editor-indent",
    keys: ["tab"],
    description: "Indent selection",
    scope: "editor-buffer",
  },
  {
    id: "editor-outdent",
    keys: ["shift", "tab"],
    description: "Outdent selection",
    scope: "editor-buffer",
  },
  {
    id: "editor-rename-symbol",
    keys: ["f2"],
    description: "Rename symbol",
    scope: "editor-buffer",
  },
  {
    // ⇧F12 — classic IDE "Find all references" (VS Code uses the same chord).
    id: "editor-find-references",
    keys: ["shift", "f12"],
    description: "Find all references",
    scope: "editor-buffer",
  },
  {
    // ⌘⇧O — "Go to symbol in file" (VS Code convention). Editor-scoped +
    // capture-phase so it wins over the feature-level ⌘⇧O (Open PR) while the
    // editor tab is focused.
    id: "editor-symbol-outline",
    keys: ["mod", "shift", "o"],
    description: "Go to symbol in file",
    scope: "editor-buffer",
  },
  {
    // ⌘T — "Go to symbol in workspace" (VS Code convention). Editor-scoped so
    // it doesn't clash with the agent tab's ⌘T (cycle thinking effort).
    id: "editor-workspace-symbols",
    keys: ["mod", "t"],
    description: "Go to symbol in workspace",
    scope: "editor-buffer",
  },
  {
    // ⌘⇧I — "Format document" (VS Code's alternate chord; we avoid VS Code's
    // default ⇧⌥F because ⌥+letter triggers a macOS dead key). Runs the
    // project's configured formatter. Capture-phase so it fires while focus
    // is inside the CodeMirror buffer.
    id: "editor-format-document",
    keys: ["mod", "shift", "i"],
    description: "Format document",
    scope: "editor-buffer",
  },
] as const satisfies readonly Shortcut[];
