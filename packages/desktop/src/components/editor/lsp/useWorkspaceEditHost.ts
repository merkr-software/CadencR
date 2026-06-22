/**
 * Builds the `WorkspaceEditHost` the rename flow uses to persist edits.
 *
 * Two persistence paths, matching `applyWorkspaceEdit`:
 * - Open files are saved through the editor save registry (which reads the
 *   live buffer the edit was just applied to). We locate the open buffer by
 *   resolving each tab's path to absolute and matching the edited URI.
 * - Closed files are read/written directly via the backend file routes. The
 *   backend accepts an absolute path as long as it canonicalizes inside the
 *   feature worktree (`validate_path` joins + `starts_with` checks), so a
 *   workspace-relative rename target resolves correctly without opening a tab.
 */
import { useCallback, useMemo } from "react";
import { readFile, writeFile } from "@/api/generated";
import { useEditorStore } from "@/stores/editor-store";
import { fileUriToPath } from "@/lib/lsp/file-uri";
import { saveFile } from "../editorSaveRegistry";
import type { WorkspaceEditHost } from "@/lib/lsp/workspace-edit";

interface Args {
  projectId: number;
  featureId: number;
  workspaceRoot: string | null;
}

function joinRoot(root: string, relative: string): string {
  if (relative.startsWith("/")) return relative;
  return `${root.replace(/\/$/, "")}/${relative}`;
}

export function useWorkspaceEditHost({
  projectId,
  featureId,
  workspaceRoot,
}: Args): WorkspaceEditHost {
  const saveOpenFile = useCallback(
    async (uri: string): Promise<void> => {
      const abs = fileUriToPath(uri);
      if (!abs || !workspaceRoot) return;
      const feature = useEditorStore.getState().features[featureId];
      if (!feature) return;
      // Find every open tab whose absolute path matches and save it. Multiple
      // panes can show the same file; saving any one persists the buffer.
      for (const [paneId, pane] of Object.entries(feature.panes)) {
        for (const tab of pane.tabs) {
          if (joinRoot(workspaceRoot, tab.filePath) === abs) {
            await saveFile(paneId, tab.filePath);
          }
        }
      }
    },
    [featureId, workspaceRoot],
  );

  const readFileText = useCallback(
    async (absPath: string): Promise<string> => {
      const res = await readFile({
        project_id: projectId,
        feature_id: featureId,
        file_path: absPath,
      });
      return res.content;
    },
    [projectId, featureId],
  );

  const writeFileText = useCallback(
    async (absPath: string, content: string): Promise<void> => {
      await writeFile({
        project_id: projectId,
        feature_id: featureId,
        file_path: absPath,
        content,
      });
    },
    [projectId, featureId],
  );

  return useMemo<WorkspaceEditHost>(
    () => ({ saveOpenFile, readFileText, writeFileText }),
    [saveOpenFile, readFileText, writeFileText],
  );
}
