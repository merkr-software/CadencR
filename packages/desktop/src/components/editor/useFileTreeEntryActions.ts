import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import type { FileTree as FileTreeModel, FileTreeRenameEvent } from "@pierre/trees";
import type { FileTreeMutations } from "@/hooks/useFileTreeMutations";
import { fromPierrePath } from "@/components/file-tree/CadencrFileTree";
import { apiErrorMessage } from "@/lib/api-errors";
import { validateSimpleName } from "@/lib/validate-name";

/** Basename of an FS-form path. */
function basenameOf(fsPath: string): string {
  return fsPath.slice(fsPath.lastIndexOf("/") + 1);
}

interface UseFileTreeEntryActionsOptions {
  model: FileTreeModel;
  projectId: number;
  featureId: number;
  mutations: FileTreeMutations;
  /** Keep open tabs pointed at the new path after a rename/move. */
  renameFilePath: (oldPath: string, newPath: string) => void;
  /** Pierre fires `onRename` for inline-draft commits too; let the draft win. */
  tryHandleAsCreate: (event: FileTreeRenameEvent) => boolean;
}

export interface FileTreeEntryActions {
  handleRename: (event: FileTreeRenameEvent) => void;
  handleDropComplete: (draggedPaths: readonly string[], pierreTargetDir: string | null) => void;
  trashPath: (pierrePath: string) => void;
}

/**
 * Rename / move / trash handlers for the editor file tree. Each issues its
 * mutation and keeps pierre's optimistic local model in sync (reversing it on
 * error). Extracted from `FileTree.tsx` to keep that component under the
 * file-size limit.
 */
export function useFileTreeEntryActions({
  model,
  projectId,
  featureId,
  mutations,
  renameFilePath,
  tryHandleAsCreate,
}: UseFileTreeEntryActionsOptions): FileTreeEntryActions {
  const handleRename = useCallback(
    (event: FileTreeRenameEvent) => {
      if (tryHandleAsCreate(event)) return;

      const pierreSource = event.sourcePath;
      const pierreDest = event.destinationPath;
      const fsSource = fromPierrePath(pierreSource);
      const fsDest = fromPierrePath(pierreDest);
      const newName = basenameOf(fsDest);

      const validationError = validateSimpleName(newName);
      if (validationError) {
        toast.error(validationError);
        model.move(pierreDest, pierreSource);
        return;
      }

      mutations.rename.mutate(
        {
          data: {
            project_id: projectId,
            feature_id: featureId,
            old_path: fsSource,
            new_name: newName,
          },
        },
        {
          // Keep any open tab for the renamed path (and tabs under a renamed
          // folder) pointing at the new filesystem path.
          onSuccess: () => renameFilePath(fsSource, fsDest),
          // Pierre already mutated its local model. Reverse it.
          onError: () => model.move(pierreDest, pierreSource),
        },
      );
    },
    [featureId, model, mutations.rename, projectId, renameFilePath, tryHandleAsCreate],
  );

  const handleDropComplete = useCallback(
    (draggedPaths: readonly string[], pierreTargetDir: string | null) => {
      const fsParent = pierreTargetDir ? fromPierrePath(pierreTargetDir) : "";
      for (const pierreSource of draggedPaths) {
        const fsSource = fromPierrePath(pierreSource);
        const basename = basenameOf(fsSource);
        const fsDest = fsParent ? `${fsParent}/${basename}` : basename;
        mutations.move.mutate(
          {
            data: {
              project_id: projectId,
              feature_id: featureId,
              old_path: fsSource,
              new_parent_path: fsParent,
            },
          },
          {
            // Update any open tabs whose path is (or sits under) the moved
            // source so they follow the file/folder.
            onSuccess: () => renameFilePath(fsSource, fsDest),
            onError: () => {
              const trailing = pierreSource.endsWith("/") ? "/" : "";
              model.move(`${fsDest}${trailing}`, pierreSource);
            },
          },
        );
      }
    },
    [featureId, model, mutations.move, projectId, renameFilePath],
  );

  // Direct trash, no confirmation: the backend moves to the system trash
  // (recoverable from Finder/Explorer). We strip the row from pierre's local
  // model on success so it disappears before the refetch reconciles.
  const trashPath = useCallback(
    (pierrePath: string) => {
      const fsPath = fromPierrePath(pierrePath);
      if (!fsPath) return;
      const isFolder = pierrePath.endsWith("/");
      mutations.trash.mutate(
        { data: { project_id: projectId, feature_id: featureId, path: fsPath } },
        {
          onSuccess: () => {
            if (model.getItem(pierrePath) != null) {
              model.remove(pierrePath, isFolder ? { recursive: true } : undefined);
            }
          },
          onError: (err) => toast.error(apiErrorMessage(err, "Failed to move to trash")),
        },
      );
    },
    [featureId, model, mutations.trash, projectId],
  );

  return useMemo<FileTreeEntryActions>(
    () => ({ handleRename, handleDropComplete, trashPath }),
    [handleRename, handleDropComplete, trashPath],
  );
}
