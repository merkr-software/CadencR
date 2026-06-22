/**
 * Apply an LSP `WorkspaceEdit` to Cadencr's files.
 *
 * Edits land in one of two ways, picked per file by whether the file is
 * currently open in the editor:
 *
 * - **Open file** — the edit is applied as a single CodeMirror transaction to
 *   the live view (offsets sorted descending so earlier edits don't shift
 *   later ones), then the host saves the buffer through the normal save path.
 *   This keeps the on-screen buffer and the unsaved-changes flag honest.
 * - **Closed file** — the file is read from disk, the edits are applied to the
 *   text, and the result is written back. We deliberately do NOT open a tab
 *   for every touched file; opening dozens of tabs on a rename would be
 *   disruptive. This is the simplest correct approach for cross-file edits.
 *
 * No optimistic store updates: both paths are real local writes via the
 * existing save/write routes, never speculative store mutations.
 */
import type { EditorView } from "@codemirror/view";
import type { ChangeSpec, Text } from "@codemirror/state";
import { LSPPlugin } from "@codemirror/lsp-client";
import { lspRangeToOffsets, type LspRange } from "./lsp-position";
import { fileUriToPath } from "./file-uri";

/** One LSP `TextEdit`. */
export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

/** Minimal `WorkspaceEdit` shape (the subset Cadencr applies). */
export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: Array<{
    textDocument?: { uri: string };
    edits?: LspTextEdit[];
  }>;
}

/**
 * Host hooks for the parts of edit application that need React/store/network
 * context the pure applier shouldn't reach for directly.
 */
export interface WorkspaceEditHost {
  /** Save an open file by URI through the editor's normal save path. */
  saveOpenFile: (uri: string) => Promise<void>;
  /** Read a closed file's full text by absolute path. */
  readFileText: (absPath: string) => Promise<string>;
  /** Write a closed file's full text by absolute path. */
  writeFileText: (absPath: string, content: string) => Promise<void>;
}

/** Result of applying a workspace edit. */
export interface WorkspaceEditResult {
  /** Number of distinct files that were modified. */
  fileCount: number;
}

/** Normalize `changes` + `documentChanges` into a single uri → edits map. */
function collectEdits(edit: LspWorkspaceEdit): Map<string, LspTextEdit[]> {
  const byUri = new Map<string, LspTextEdit[]>();
  const add = (uri: string, edits: LspTextEdit[]): void => {
    if (edits.length === 0) return;
    const existing = byUri.get(uri);
    if (existing) existing.push(...edits);
    else byUri.set(uri, [...edits]);
  };
  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) add(uri, edits);
  }
  for (const dc of edit.documentChanges ?? []) {
    const uri = dc.textDocument?.uri;
    if (uri && dc.edits) add(uri, dc.edits);
  }
  return byUri;
}

/**
 * Apply `edits` to a plain string. Edits are mapped to offsets against the
 * source text and applied from the end backwards so earlier replacements
 * don't invalidate the offsets of later ones.
 */
export function applyEditsToText(doc: Text, edits: LspTextEdit[]): string {
  const resolved = edits
    .map((e) => ({ ...lspRangeToOffsets(doc, e.range), insert: e.newText }))
    .sort((a, b) => b.from - a.from || b.to - a.to);
  let text = doc.toString();
  for (const e of resolved) {
    text = text.slice(0, e.from) + e.insert + text.slice(e.to);
  }
  return text;
}

/** Build a descending-ordered CodeMirror change set for an open view. */
function toChangeSpec(doc: Text, edits: LspTextEdit[]): ChangeSpec[] {
  return edits
    .map((e) => ({ ...lspRangeToOffsets(doc, e.range), insert: e.newText }))
    .sort((a, b) => b.from - a.from || b.to - a.to);
}

/**
 * Apply a `WorkspaceEdit` across all affected files. Returns the number of
 * files changed. Throws if any file cannot be located/written so the caller
 * can surface a single toast — partial application still happens for the files
 * that succeeded before the failure, matching how editors behave.
 */
export async function applyWorkspaceEdit(
  view: EditorView,
  edit: LspWorkspaceEdit,
  host: WorkspaceEditHost,
): Promise<WorkspaceEditResult> {
  const plugin = LSPPlugin.get(view);
  if (!plugin) throw new Error("No language server attached");
  const workspace = plugin.client.workspace;
  const byUri = collectEdits(edit);
  let fileCount = 0;

  for (const [uri, edits] of byUri) {
    const openView = workspace.getFile(uri)?.getView() ?? null;
    if (openView) {
      const changes = toChangeSpec(openView.state.doc, edits);
      openView.dispatch({ changes, userEvent: "lsp.rename" });
      await host.saveOpenFile(uri);
      fileCount += 1;
      continue;
    }
    const absPath = fileUriToPath(uri);
    if (!absPath) throw new Error(`Cannot resolve file: ${uri}`);
    const original = await host.readFileText(absPath);
    const docLike = textFromString(view, original);
    const next = applyEditsToText(docLike, edits);
    if (next !== original) {
      await host.writeFileText(absPath, next);
    }
    fileCount += 1;
  }

  return { fileCount };
}

/**
 * Build a CodeMirror `Text` from a string by reusing the originating view's
 * `Text` constructor, so offset math matches CodeMirror's own line splitting.
 */
function textFromString(view: EditorView, content: string): Text {
  return view.state.toText(content);
}
