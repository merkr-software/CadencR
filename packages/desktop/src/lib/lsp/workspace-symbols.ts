/**
 * Workspace symbols (`workspace/symbol`) for the Cmd+T quick picker.
 *
 * The server matches symbols across the whole project against the query
 * string; we return location + kind so the picker can jump via the shared
 * `openLspLocation` helper. The query is debounced by the picker, not here.
 */
import type { EditorView } from "@codemirror/view";
import { LSPPlugin } from "@codemirror/lsp-client";
import type { LspLocation, SymbolKind, LspRange } from "./lsp-position";

interface WorkspaceSymbol {
  name: string;
  kind: SymbolKind;
  containerName?: string;
  location: { uri: string; range?: LspRange };
}

/** A workspace symbol resolved for the picker. */
export interface WorkspaceSymbolResult {
  name: string;
  kind: SymbolKind;
  containerName?: string;
  location: LspLocation;
}

/** True when the type-checker server advertises workspace-symbol support. */
export function canWorkspaceSymbols(view: EditorView): boolean {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return false;
  return Boolean(plugin.client.serverCapabilities?.workspaceSymbolProvider);
}

const ZERO_RANGE: LspRange = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 0 },
};

/**
 * Query workspace symbols. Returns an empty array for an empty query or when
 * the server has no matches; throws on request failure so callers can toast.
 */
export async function workspaceSymbols(
  view: EditorView,
  query: string,
): Promise<WorkspaceSymbolResult[]> {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return [];
  if (query.trim() === "") return [];
  plugin.client.sync();
  const response = await plugin.client.request<unknown, WorkspaceSymbol[] | null>(
    "workspace/symbol",
    { query },
  );
  if (!response) return [];
  return response.map((s) => ({
    name: s.name,
    kind: s.kind,
    containerName: s.containerName,
    location: { uri: s.location.uri, range: s.location.range ?? ZERO_RANGE },
  }));
}
