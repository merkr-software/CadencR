/**
 * Find-references via the type-checker LSP client.
 *
 * `textDocument/references` with `includeDeclaration: true`. Returns the raw
 * locations; the React panel groups them by file, virtualizes the list, and
 * jumps to a location with the shared `openLspLocation` helper.
 */
import type { EditorView } from "@codemirror/view";
import { LSPPlugin } from "@codemirror/lsp-client";
import type { LspLocation } from "./lsp-position";

/** True when the type-checker server advertises references support. */
export function canFindReferences(view: EditorView): boolean {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return false;
  return Boolean(plugin.client.serverCapabilities?.referencesProvider);
}

/**
 * Request all references (including the declaration) to the symbol at the
 * cursor. Returns an empty array when the server has nothing; throws on a
 * request failure so the caller can toast.
 */
export async function findReferences(view: EditorView): Promise<LspLocation[]> {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return [];
  plugin.client.sync();
  const response = await plugin.client.request<unknown, LspLocation[] | null>(
    "textDocument/references",
    {
      textDocument: { uri: plugin.uri },
      position: plugin.toPosition(view.state.selection.main.head),
      context: { includeDeclaration: true },
    },
  );
  return response ?? [];
}
