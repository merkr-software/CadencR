import { translateUi, type UiTranslator } from "@/lib/i18n/ui";
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
export function symbolKindLabel(kind: SymbolKind, t: UiTranslator = translateUi): string {
  switch (kind) {
    case 1:
      return t("workspace.editor.symbols.file", "file");
    case 2:
      return t("workspace.editor.symbols.module", "module");
    case 3:
      return t("workspace.editor.symbols.namespace", "namespace");
    case 4:
      return t("workspace.editor.symbols.package", "package");
    case 5:
      return t("workspace.editor.symbols.class", "class");
    case 6:
      return t("workspace.editor.symbols.method", "method");
    case 7:
      return t("workspace.editor.symbols.property", "property");
    case 8:
      return t("workspace.editor.symbols.field", "field");
    case 9:
      return t("workspace.editor.symbols.constructor", "constructor");
    case 10:
      return t("workspace.editor.symbols.enum", "enum");
    case 11:
      return t("workspace.editor.symbols.interface", "interface");
    case 12:
      return t("workspace.editor.symbols.function", "function");
    case 13:
      return t("workspace.editor.symbols.variable", "variable");
    case 14:
      return t("workspace.editor.symbols.constant", "constant");
    case 15:
      return t("workspace.editor.symbols.string", "string");
    case 16:
      return t("workspace.editor.symbols.number", "number");
    case 17:
      return t("workspace.editor.symbols.boolean", "boolean");
    case 18:
      return t("workspace.editor.symbols.array", "array");
    case 19:
      return t("workspace.editor.symbols.object", "object");
    case 20:
      return t("workspace.editor.symbols.key", "key");
    case 21:
      return t("workspace.editor.symbols.null", "null");
    case 22:
      return t("workspace.editor.symbols.enumMember", "enum member");
    case 23:
      return t("workspace.editor.symbols.struct", "struct");
    case 24:
      return t("workspace.editor.symbols.event", "event");
    case 25:
      return t("workspace.editor.symbols.operator", "operator");
    case 26:
      return t("workspace.editor.symbols.typeParam", "type param");
    default:
      return "";
  }
}

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
