/**
 * Mounts the editor's LSP navigation/refactor commands and their UI:
 * find-references (Shift+F12), rename (F2), document-symbol outline
 * (Cmd+Shift+O) and workspace symbols (Cmd+T).
 *
 * Each shortcut is editor-scoped and capture-phase (so it fires before
 * CodeMirror swallows the key) and calls `stopPropagation` so editor-focused
 * chords win over any same-combo feature-level binding (e.g. Cmd+Shift+O is
 * "Open PR" at the feature level). Lives outside `CodeMirrorEditor` to keep
 * that file under the size cap.
 */
import { useCallback, useEffect, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { toast } from "sonner";
import { useScopedGlobalShortcutById } from "@/hooks/useShortcut";
import { findReferences, canFindReferences } from "@/lib/lsp/references";
import type { LspLocation } from "@/lib/lsp/lsp-position";
import { registerApplyEdit } from "@/lib/lsp/apply-edit-bridge";
import { EditorRenamePanel } from "./EditorRenamePanel";
import EditorReferencesPanel from "./EditorReferencesPanel";
import { EditorSymbolPicker } from "./EditorSymbolPicker";
import { EditorWorkspaceSymbolPicker } from "./EditorWorkspaceSymbolPicker";
import { useWorkspaceEditHost } from "./useWorkspaceEditHost";

interface EditorLspCommandsProps {
  view: EditorView;
  projectId: number;
  featureId: number;
  workspaceRoot: string | null;
  /** Only mount when the LSP layer is active (not large-file mode). */
  enabled: boolean;
}

export function EditorLspCommands({
  view,
  projectId,
  featureId,
  workspaceRoot,
  enabled,
}: EditorLspCommandsProps) {
  const host = useWorkspaceEditHost({ projectId, featureId, workspaceRoot });

  // Let the transport apply server-pushed `workspace/applyEdit` requests
  // through this editor's host while it's mounted.
  useEffect(() => registerApplyEdit(view, host), [view, host]);

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameSignal, setRenameSignal] = useState(0);
  const [references, setReferences] = useState<LspLocation[] | null>(null);
  const [symbolPickerOpen, setSymbolPickerOpen] = useState(false);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);

  const openRename = useCallback((): void => {
    setRenameOpen(true);
    setRenameSignal((n) => n + 1);
  }, []);

  const runFindReferences = useCallback((): void => {
    if (!canFindReferences(view)) {
      toast.info("This language server doesn't support find references.");
      return;
    }
    void findReferences(view)
      .then((locs) => {
        if (locs.length === 0) {
          toast.info("No references found.");
          return;
        }
        setReferences(locs);
      })
      .catch((err: unknown) => {
        toast.error(`Find references failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  }, [view]);

  useScopedGlobalShortcutById(
    "editor-rename-symbol",
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      openRename();
    },
    "editor",
    { enabled },
  );

  useScopedGlobalShortcutById(
    "editor-find-references",
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      runFindReferences();
    },
    "editor",
    { enabled },
  );

  useScopedGlobalShortcutById(
    "editor-symbol-outline",
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      setSymbolPickerOpen(true);
    },
    "editor",
    { enabled },
  );

  useScopedGlobalShortcutById(
    "editor-workspace-symbols",
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      setWorkspacePickerOpen(true);
    },
    "editor",
    { enabled },
  );

  return (
    <>
      {renameOpen && (
        <EditorRenamePanel
          view={view}
          reopenSignal={renameSignal}
          host={host}
          onClose={() => setRenameOpen(false)}
        />
      )}
      {references && (
        <EditorReferencesPanel
          view={view}
          references={references}
          workspaceRoot={workspaceRoot}
          open
          onOpenChange={(open) => {
            if (!open) setReferences(null);
          }}
        />
      )}
      {symbolPickerOpen && (
        <EditorSymbolPicker view={view} open onOpenChange={setSymbolPickerOpen} />
      )}
      {workspacePickerOpen && (
        <EditorWorkspaceSymbolPicker view={view} open onOpenChange={setWorkspacePickerOpen} />
      )}
    </>
  );
}
