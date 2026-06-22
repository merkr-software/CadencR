/**
 * Bridge for server-initiated `workspace/applyEdit` requests.
 *
 * Most refactors (rename, organize-imports) return their `WorkspaceEdit` in
 * the request *response*, which Cadencr applies directly (see `rename.ts`).
 * But a server may also push edits via the `workspace/applyEdit` request — the
 * transport (a module-level singleton with no React/store access) needs a way
 * to apply those. The active editor registers an applier here; the transport
 * calls it.
 *
 * Only one applier is registered at a time (the most recently mounted editor).
 * That's sufficient: server-initiated edits target whatever the user is
 * working in, and the applier itself fans the edit out to all affected files.
 */
import type { EditorView } from "@codemirror/view";
import {
  applyWorkspaceEdit,
  type LspWorkspaceEdit,
  type WorkspaceEditHost,
} from "./workspace-edit";

interface ApplierEntry {
  view: EditorView;
  host: WorkspaceEditHost;
}

let active: ApplierEntry | null = null;

/** Register the active editor's applier. Returns an unregister function. */
export function registerApplyEdit(view: EditorView, host: WorkspaceEditHost): () => void {
  active = { view, host };
  return () => {
    if (active?.view === view) active = null;
  };
}

/** Result mirroring the LSP `ApplyWorkspaceEditResult`. */
export interface ApplyEditOutcome {
  applied: boolean;
  failureReason?: string;
}

/**
 * Apply a server-pushed `WorkspaceEdit` using the active editor's applier.
 * Returns `{ applied: false }` with a reason when no editor is mounted or the
 * apply fails — the transport relays this back to the server.
 */
export async function applyServerEdit(edit: LspWorkspaceEdit): Promise<ApplyEditOutcome> {
  if (!active) {
    return { applied: false, failureReason: "No active editor to apply the edit." };
  }
  try {
    await applyWorkspaceEdit(active.view, edit, active.host);
    return { applied: true };
  } catch (err) {
    return { applied: false, failureReason: err instanceof Error ? err.message : String(err) };
  }
}
