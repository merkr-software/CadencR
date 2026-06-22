/**
 * Symbol rename via the type-checker LSP client.
 *
 * Two-step flow mirroring LSP: `textDocument/prepareRename` validates the
 * cursor is on a renameable symbol and returns its range + placeholder, then
 * `textDocument/rename` returns a `WorkspaceEdit` we apply across every
 * affected file (see `applyWorkspaceEdit`).
 *
 * Errors are surfaced by the caller (the rename panel) as toasts; the helpers
 * here throw/return null and never paint CodeMirror's red banner.
 */
import type { EditorView } from "@codemirror/view";
import { LSPPlugin } from "@codemirror/lsp-client";
import type { LspRange } from "./lsp-position";
import { lspRangeToOffsets } from "./lsp-position";
import {
  applyWorkspaceEdit,
  type LspWorkspaceEdit,
  type WorkspaceEditHost,
  type WorkspaceEditResult,
} from "./workspace-edit";

/** Result of a prepare-rename probe. */
export interface PrepareRenameResult {
  /** Document offsets of the symbol to rename. */
  from: number;
  to: number;
  /** Suggested initial name for the input. */
  placeholder: string;
}

interface PrepareRenameResponse {
  range?: LspRange;
  placeholder?: string;
  start?: { line: number; character: number };
  end?: { line: number; character: number };
  defaultBehavior?: boolean;
}

/**
 * Probe whether the symbol at the cursor can be renamed. Returns the symbol's
 * range + placeholder, or `null` when there is nothing renameable. Falls back
 * to the editor's word-at-cursor when the server doesn't implement
 * `prepareRename` but does support `rename`.
 */
export async function prepareRename(view: EditorView): Promise<PrepareRenameResult | null> {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return null;
  const head = view.state.selection.main.head;
  const caps = plugin.client.serverCapabilities?.renameProvider;
  if (!caps) return null;

  // Servers advertise prepareRename as `renameProvider.prepareProvider`.
  const supportsPrepare = typeof caps === "object" && caps.prepareProvider === true;
  if (supportsPrepare) {
    plugin.client.sync();
    const response = await plugin.client.request<unknown, PrepareRenameResponse | null>(
      "textDocument/prepareRename",
      { textDocument: { uri: plugin.uri }, position: plugin.toPosition(head) },
    );
    const range = response?.range ?? (response?.start && response?.end ? response : null);
    if (range && "start" in range && range.start && range.end) {
      const { from, to } = lspRangeToOffsets(view.state.doc, range as LspRange);
      return {
        from,
        to,
        placeholder: response?.placeholder ?? view.state.sliceDoc(from, to),
      };
    }
    if (response === null) return null;
  }

  // No prepare support (or it returned a bare range): use the word at cursor.
  const word = view.state.wordAt(head);
  if (!word) return null;
  return { from: word.from, to: word.to, placeholder: view.state.sliceDoc(word.from, word.to) };
}

/**
 * Request a rename of the symbol at the cursor to `newName` and apply the
 * resulting edit. Returns the apply result (file count). Throws on request or
 * apply failure so the caller can toast.
 */
export async function performRename(
  view: EditorView,
  newName: string,
  host: WorkspaceEditHost,
): Promise<WorkspaceEditResult> {
  const plugin = LSPPlugin.get(view);
  if (!plugin) throw new Error("No language server attached");
  plugin.client.sync();
  const edit = await plugin.client.request<unknown, LspWorkspaceEdit | null>(
    "textDocument/rename",
    {
      textDocument: { uri: plugin.uri },
      position: plugin.toPosition(view.state.selection.main.head),
      newName,
    },
  );
  if (!edit) throw new Error("Server returned no rename edit");
  return applyWorkspaceEdit(view, edit, host);
}
