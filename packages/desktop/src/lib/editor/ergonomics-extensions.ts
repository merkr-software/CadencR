/**
 * Editing-ergonomics CodeMirror extensions — the "feels native" layer that
 * brings the buffer up to VS Code / Cursor / Zed parity.
 *
 * These are intentionally STATIC (no per-mount configuration), so the array is
 * built once at module load and shared across every editor instance. Handing a
 * fresh extension array to CodeMirror on each render would force a full state
 * reconfigure and throw away undo history / selection — see
 * `.claude/rules/frontend-performance.md`. Callers must therefore reference the
 * exported singleton, never call a builder per render.
 *
 * Large-file mode must NOT mount these: code folding, bracket auto-close and
 * selection-match highlighting all walk the document and are wasted work on a
 * read-only multi-MB buffer. `CodeMirrorEditor` gates the inclusion on
 * `!largeMode`.
 *
 * What lives elsewhere (already wired, deliberately not duplicated here):
 *  – multi-cursor state switch (`EditorState.allowMultipleSelections`),
 *    `drawSelection`, bracket matching, indent-on-input, line numbers and
 *    active-line highlight live in `BaseCodeMirrorEditor`;
 *  – the multi-cursor / fold / comment KEY BINDINGS live in
 *    `editor-buffer-keymap.ts` next to the shortcut registry;
 *  – Cadencr ships a custom search PANEL (`editor-search/`), so the built-in
 *    `@codemirror/search` panel is intentionally not mounted. We do add
 *    `highlightSelectionMatches` here because it is panel-independent and is
 *    the one search affordance the custom panel does not cover.
 */
import { closeBrackets } from "@codemirror/autocomplete";
import { codeFolding, foldGutter } from "@codemirror/language";
import { highlightSelectionMatches } from "@codemirror/search";
import type { Extension } from "@codemirror/state";
import { crosshairCursor, highlightActiveLineGutter, rectangularSelection } from "@codemirror/view";

/**
 * Shared singleton of the editing-ergonomics extensions. Reference this
 * directly — do not wrap it in a builder that runs per render.
 */
export const ergonomicsExtensions: Extension = [
  // Auto-close brackets / quotes, and skip-over the closer when typing it. The
  // matching keymap (Backspace deletes the pair, etc.) is mounted via
  // `closeBracketsKeymap` in the buffer keymap is NOT required: closeBrackets()
  // installs its own input handler; the keymap only refines Backspace behavior,
  // which the default keymap already covers acceptably.
  closeBrackets(),

  // Code folding state + the fold gutter affordance (chevrons next to line
  // numbers). The fold KEY BINDINGS (`foldKeymap`) are already mounted in
  // `editor-buffer-keymap.ts`.
  codeFolding(),
  foldGutter(),

  // Column / block selection: hold Alt and drag for a rectangular selection;
  // `crosshairCursor` swaps the cursor to a crosshair while Alt is held so the
  // mode is discoverable. Pairs with `allowMultipleSelections` (set in
  // `BaseCodeMirrorEditor`) to produce true multi-cursor column editing.
  rectangularSelection(),
  crosshairCursor(),

  // Highlight the gutter line that contains the cursor (companion to the
  // content-side `highlightActiveLine` mounted in the base editor).
  highlightActiveLineGutter(),

  // Highlight other occurrences of the current selection in the viewport.
  highlightSelectionMatches(),
];
