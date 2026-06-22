/**
 * The library-provided language-feature extensions Cadencr layers on top of
 * the type-checker LSP plugin: hover tooltips and signature help.
 *
 * Both come straight from `@codemirror/lsp-client` — there's no reason to
 * reimplement them, and they resolve the active client via `LSPPlugin.get`,
 * which (because the type checker's plugin is mounted first) targets the type
 * checker, not a linter. Completion is mounted separately in `useLsp` via
 * `serverCompletion()`.
 *
 * Built once at module load and reused so the extension array stays
 * referentially stable across editor re-renders (see frontend-performance
 * rules: memoized extension arrays).
 *
 * `signatureHelp()` binds its own keymap (Cmd/Ctrl+Shift+Space to show,
 * Cmd/Ctrl+Shift+Up/Down to cycle) unless `keymap: false`; we keep the
 * default keymap so signature help is keyboard-reachable.
 */
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { hoverTooltips, signatureHelp } from "@codemirror/lsp-client";

/**
 * Bound the hover tooltip's size. The library's own base theme caps the
 * *signature* tooltip at `30em` but leaves hover documentation
 * (`.cm-lsp-documentation`) unconstrained, so a long type or JSDoc block can
 * stretch the popover across the entire viewport. Cap it to a readable column
 * with scrollable overflow, and force long unbroken tokens (deep generic types,
 * URLs) to wrap instead of widening the box.
 */
const hoverTooltipTheme = EditorView.theme({
  ".cm-tooltip.cm-tooltip-hover": {
    maxWidth: "min(60ch, 90vw)",
    maxHeight: "min(24em, 60vh)",
    overflow: "auto",
  },
  ".cm-tooltip-hover .cm-lsp-documentation": {
    overflowWrap: "anywhere",
  },
  ".cm-tooltip-hover .cm-lsp-documentation pre": {
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
});

/** Hover tooltips + signature help, mounted on the type-checker client. */
export const lspLanguageFeatures: Extension = [hoverTooltips(), signatureHelp(), hoverTooltipTheme];
