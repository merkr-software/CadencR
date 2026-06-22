/**
 * Shared LSP position/location plumbing for Cadencr's language-feature
 * commands (go-to-definition, find-references, rename, symbols).
 *
 * LSP positions are zero-based `{ line, character }`; CodeMirror works in
 * flat document offsets. These helpers convert between the two and own the
 * single "open a location in the right pane and select it" routine so the
 * navigation commands stay consistent.
 */
import type { EditorView } from "@codemirror/view";
import type { Text } from "@codemirror/state";
import { LSPPlugin } from "@codemirror/lsp-client";

/** Zero-based LSP position. */
export interface LspPosition {
  line: number;
  character: number;
}

/** LSP range. */
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/** LSP location: a range within a file URI. */
export interface LspLocation {
  uri: string;
  range: LspRange;
}

/** LSP `SymbolKind` numeric code (1=File … 26=TypeParameter). */
export type SymbolKind = number;

/**
 * Short human label for an LSP `SymbolKind`, used by the symbol pickers and
 * breadcrumbs. Unknown kinds fall back to an empty string so the UI just
 * shows the name.
 */
export function symbolKindLabel(kind: SymbolKind): string {
  return SYMBOL_KIND_LABELS[kind] ?? "";
}

const SYMBOL_KIND_LABELS: Record<number, string> = {
  1: "file",
  2: "module",
  3: "namespace",
  4: "package",
  5: "class",
  6: "method",
  7: "property",
  8: "field",
  9: "constructor",
  10: "enum",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
  15: "string",
  16: "number",
  17: "boolean",
  18: "array",
  19: "object",
  20: "key",
  21: "null",
  22: "enum member",
  23: "struct",
  24: "event",
  25: "operator",
  26: "type param",
};

/**
 * Convert a single LSP position to a CodeMirror offset, clamped to the
 * document so an out-of-range position from a drifted server can never throw.
 */
export function lspPositionToOffset(doc: Text, pos: LspPosition): number {
  const lineNumber = Math.min(Math.max(pos.line + 1, 1), doc.lines);
  const line = doc.line(lineNumber);
  const offset = line.from + Math.max(pos.character, 0);
  return Math.min(offset, line.to);
}

/** Convert an LSP range to a `{ from, to }` offset pair against `doc`. */
export function lspRangeToOffsets(doc: Text, range: LspRange): { from: number; to: number } {
  return {
    from: lspPositionToOffset(doc, range.start),
    to: lspPositionToOffset(doc, range.end),
  };
}

/**
 * Open `location` in front of the user and move the selection to its start.
 *
 * Mirrors `definition.ts`'s navigation logic so every "jump to a location"
 * command behaves identically: same-file jumps reuse the current view,
 * cross-file jumps go through the workspace `displayFile` bridge (which opens
 * a Cadencr tab in the originating pane). Returns the target view, or `null`
 * when the file could not be displayed.
 */
export async function openLspLocation(
  view: EditorView,
  location: LspLocation,
): Promise<EditorView | null> {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return null;
  const target =
    location.uri === plugin.uri ? view : await plugin.client.workspace.displayFile(location.uri);
  if (!target) return null;
  const pos = lspPositionToOffset(target.state.doc, location.range.start);
  target.dispatch({
    selection: { anchor: pos },
    scrollIntoView: true,
    userEvent: "select.lsp",
  });
  target.focus();
  return target;
}
