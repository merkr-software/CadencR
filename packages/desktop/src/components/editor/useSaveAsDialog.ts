/**
 * Save-As flow for "untitled" scratch buffers (the CMD+N → type → CMD+S
 * path). Opens the native save dialog via the desktop bridge, computes a
 * project-relative path, posts to `/api/editor/write`, then asks the
 * editor store to swap the untitled tab identity for the real file path.
 *
 * The backend's `validate_path_for_write` rejects anything outside the
 * project root, so we mirror that check on the client and surface a
 * toast instead of waiting for the round-trip error.
 */
import { useCallback } from "react";
import { toast } from "sonner";
import { relativeToProject } from "@/lib/relative-path";
import { useWriteFile, useGetFeatureWorkingDir } from "@/api/generated";
import { useEditorStore } from "@/stores/editor-store";
import { desktopBridge } from "@/lib/desktop-bridge";
import { toastError } from "@/lib/api-errors";

interface SaveAsDialogOptions {
  projectId: number;
  featureId: number;
  paneId: string;
}

interface SaveAsDialogResult {
  /** Opens the dialog, writes the chosen file, and converts the tab.
   *  Resolves silently on cancel or after surfacing a toast on error. */
  saveAs: (untitledPath: string, suggestedName: string, content: string) => Promise<void>;
  /** Loading state for the write API call — surface in the status bar. */
  isSaving: boolean;
}

export function useSaveAsDialog({
  projectId,
  featureId,
  paneId,
}: SaveAsDialogOptions): SaveAsDialogResult {
  const writeFile = useWriteFile();
  const convertUntitledToFile = useEditorStore((s) => s.convertUntitledToFile);

  const cwdQuery = useGetFeatureWorkingDir(
    featureId,
    { project_id: projectId },
    { query: { enabled: Boolean(featureId && projectId), refetchOnWindowFocus: false } },
  );
  const projectRoot = cwdQuery.data?.path ?? null;

  const saveAs = useCallback(
    async (untitledPath: string, suggestedName: string, content: string): Promise<void> => {
      if (!projectRoot) {
        toast.error("Project working directory not loaded yet — try again.");
        return;
      }
      let chosenPath: string | null;
      try {
        chosenPath = await desktopBridge.showSaveDialog({
          defaultPath: `${projectRoot.replace(/[\\/]+$/, "")}/${suggestedName}`,
          title: "Save File As",
        });
      } catch (err) {
        toastError(err, "Failed to open save dialog");
        return;
      }
      if (!chosenPath) return; // user canceled

      const relative = relativeToProject(chosenPath, projectRoot);
      if (relative === null || relative.length === 0) {
        toast.error("File must be saved inside the project folder.");
        return;
      }

      try {
        await writeFile.mutateAsync({
          data: {
            project_id: projectId,
            feature_id: featureId,
            file_path: relative,
            content,
          },
        });
      } catch (err) {
        toastError(err, "Failed to save file");
        return;
      }

      convertUntitledToFile(featureId, paneId, untitledPath, relative);
    },
    [projectRoot, projectId, featureId, paneId, writeFile, convertUntitledToFile],
  );

  return { saveAs, isSaving: writeFile.isPending };
}
