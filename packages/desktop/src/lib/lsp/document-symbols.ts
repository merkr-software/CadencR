/**
 * Document symbols (`textDocument/documentSymbol`) for the outline quick
 * picker and the breadcrumbs bar.
 *
 * Servers return either the hierarchical `DocumentSymbol[]` (with `children`
 * and a `range`/`selectionRange`) or the flat legacy `SymbolInformation[]`
 * (with `location`). We normalize both into a flat list carrying depth + a
 * resolved offset range so the picker can indent and the breadcrumbs can find
 * the symbol path at the cursor.
 */
import type { EditorView } from "@codemirror/view";
import { LSPPlugin } from "@codemirror/lsp-client";
import { lspRangeToOffsets, type LspRange, type SymbolKind } from "./lsp-position";

interface DocumentSymbol {
  name: string;
  kind: SymbolKind;
  range: LspRange;
  selectionRange: LspRange;
  children?: DocumentSymbol[];
}

interface SymbolInformation {
  name: string;
  kind: SymbolKind;
  location: { range: LspRange };
  containerName?: string;
}

type DocumentSymbolResponse = DocumentSymbol[] | SymbolInformation[] | null;

/** A symbol flattened for display: depth for indentation, offsets for jumps. */
export interface FlatSymbol {
  name: string;
  kind: SymbolKind;
  depth: number;
  /** Offset to place the cursor at (the symbol's name). */
  selectionFrom: number;
  /** Full symbol range (used to test cursor containment for breadcrumbs). */
  from: number;
  to: number;
}

/** True when the type-checker server advertises document-symbol support. */
export function canDocumentSymbols(view: EditorView): boolean {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return false;
  return Boolean(plugin.client.serverCapabilities?.documentSymbolProvider);
}

function isHierarchical(items: DocumentSymbol[] | SymbolInformation[]): items is DocumentSymbol[] {
  const first = items[0] as DocumentSymbol | SymbolInformation | undefined;
  return first != null && "selectionRange" in first;
}

/** Recursively flatten hierarchical symbols, tracking depth. */
function flattenHierarchical(
  view: EditorView,
  symbols: DocumentSymbol[],
  depth: number,
  out: FlatSymbol[],
): void {
  for (const s of symbols) {
    const range = lspRangeToOffsets(view.state.doc, s.range);
    const sel = lspRangeToOffsets(view.state.doc, s.selectionRange);
    out.push({
      name: s.name,
      kind: s.kind,
      depth,
      selectionFrom: sel.from,
      from: range.from,
      to: range.to,
    });
    if (s.children?.length) flattenHierarchical(view, s.children, depth + 1, out);
  }
}

/**
 * Request and flatten the file's symbols. Returns an empty array when the
 * server has none; throws on request failure so callers can toast.
 */
export async function documentSymbols(view: EditorView): Promise<FlatSymbol[]> {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return [];
  plugin.client.sync();
  const response = await plugin.client.request<unknown, DocumentSymbolResponse>(
    "textDocument/documentSymbol",
    { textDocument: { uri: plugin.uri } },
  );
  if (!response || response.length === 0) return [];
  const out: FlatSymbol[] = [];
  if (isHierarchical(response)) {
    flattenHierarchical(view, response, 0, out);
  } else {
    for (const s of response) {
      const range = lspRangeToOffsets(view.state.doc, s.location.range);
      out.push({
        name: s.name,
        kind: s.kind,
        depth: 0,
        selectionFrom: range.from,
        from: range.from,
        to: range.to,
      });
    }
  }
  return out;
}
