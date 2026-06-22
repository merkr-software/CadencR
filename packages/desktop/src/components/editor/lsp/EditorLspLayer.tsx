/**
 * Mount point for the editor's LSP command layer: the navigation/refactor
 * commands + dialogs (find-references, rename, symbol pickers).
 *
 * Extracted from `CodeMirrorEditor` so that file stays under the size cap. The
 * commands are headless overlays mounted alongside the other editor overlays.
 */
import type { EditorView } from "@codemirror/view";
import { EditorLspCommands } from "./EditorLspCommands";

interface CommandsSlotProps {
  view: EditorView;
  projectId: number;
  featureId: number;
  workspaceRoot: string | null;
}

/** Headless LSP commands + their dialogs/overlays. */
export function EditorCommandsSlot({
  view,
  projectId,
  featureId,
  workspaceRoot,
}: CommandsSlotProps) {
  return (
    <EditorLspCommands
      view={view}
      projectId={projectId}
      featureId={featureId}
      workspaceRoot={workspaceRoot}
      enabled
    />
  );
}
