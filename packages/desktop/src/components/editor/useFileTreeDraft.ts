import { useCallback, useEffect, useRef, type RefObject } from "react";
import { toast } from "sonner";
import type { FileTree as FileTreeModel, FileTreeRenameEvent } from "@pierre/trees";
import type { FileTreeMutations } from "@/hooks/useFileTreeMutations";
import { fromPierrePath, toPierrePath } from "@/components/file-tree/CadencrFileTree";
import { typedEntryName } from "@/components/file-tree/cadencrFileTreeModel";
import { validateSimpleName } from "@/lib/validate-name";

export type DraftKind = "file" | "folder";

interface DraftState {
  pierrePath: string;
  kind: DraftKind;
  parentDir: string;
}

/**
 * Pierre stores paths as strings and uses the leaf name as the initial
 * value of the rename input. We give drafts a single-space leaf for two
 * reasons:
 *
 *  - `input.select()` (which pierre runs on focus) selects the whole
 *    leaf, so a single space looks effectively empty and any keystroke
 *    replaces it.
 *  - Pierre's controller treats `value.trim().length === 0` on commit as
 *    "remove the placeholder" — so pressing Enter on an unmodified draft
 *    just discards it instead of creating a literally-named file.
 *
 * Only one draft is alive at a time, so the constant leaf is safe.
 */
const DRAFT_LEAF = " ";

function makeDraftPath(parentDir: string, kind: DraftKind): string {
  return toPierrePath({
    path: parentDir ? `${parentDir}/${DRAFT_LEAF}` : DRAFT_LEAF,
    is_dir: kind === "folder",
  });
}

function pierrePathForKind(path: string, kind: DraftKind): string {
  return toPierrePath({ path: fromPierrePath(path), is_dir: kind === "folder" });
}

function removeDraftFromModel(model: FileTreeModel, path: string, kind: DraftKind): void {
  const recursive = kind === "folder";
  const candidate = pierrePathForKind(path, kind);
  if (model.getItem(candidate) != null) {
    model.remove(candidate, recursive ? { recursive: true } : undefined);
  }
}

function addConfirmedCreateToModel(model: FileTreeModel, fsPath: string, kind: DraftKind): void {
  const pierrePath = toPierrePath({ path: fsPath, is_dir: kind === "folder" });
  if (model.getItem(pierrePath) == null) model.add(pierrePath);
}

interface UseFileTreeDraftOptions {
  model: FileTreeModel;
  projectId: number;
  featureId: number;
  mutations: FileTreeMutations;
  /** Called after the backend confirms a file create so the editor can open it. */
  onFileCreated: (fsPath: string) => void;
  /** Reset on feature change so a stale draft doesn't leak into a new feature. */
  featureKey: number;
}

interface UseFileTreeDraftResult {
  /** Begin an inline-create draft under `parentDir`. */
  startCreate: (kind: DraftKind, parentDir: string) => void;
  /** True if `pierrePath` is the active draft (so callers can skip it). */
  isDraftPath: (pierrePath: string | null) => boolean;
  /**
   * Try to handle a pierre `onRename` event as a draft-create commit.
   * Returns `true` if this was a create (caller should stop), `false` if
   * it's a regular rename (caller handles it).
   */
  tryHandleAsCreate: (event: FileTreeRenameEvent) => boolean;
}

function useDraftLifecycle(
  model: FileTreeModel,
  featureKey: number,
  draftRef: RefObject<DraftState | null>,
): void {
  useEffect(() => {
    const unsubscribe = model.onMutation("remove", (event) => {
      if (draftRef.current && event.path === draftRef.current.pierrePath) {
        draftRef.current = null;
      }
    });
    return unsubscribe;
  }, [draftRef, model]);
  useEffect(() => {
    draftRef.current = null;
  }, [draftRef, featureKey]);
}

function useStartCreate(
  model: FileTreeModel,
  draftRef: RefObject<DraftState | null>,
): UseFileTreeDraftResult["startCreate"] {
  return useCallback(
    (kind: DraftKind, parentDir: string) => {
      const previous = draftRef.current;
      if (previous) {
        draftRef.current = null;
        if (model.getItem(previous.pierrePath) != null) {
          model.remove(
            previous.pierrePath,
            previous.kind === "folder" ? { recursive: true } : undefined,
          );
        }
      }
      const pierrePath = makeDraftPath(parentDir, kind);
      draftRef.current = { pierrePath, kind, parentDir };
      model.add(pierrePath);
      const started = model.startRenaming(pierrePath, { removeIfCanceled: true });
      if (!started) {
        draftRef.current = null;
        if (model.getItem(pierrePath) != null) {
          model.remove(pierrePath, kind === "folder" ? { recursive: true } : undefined);
        }
        toast.error("Could not start inline create");
      }
    },
    [draftRef, model],
  );
}

/**
 * Owns the "draft" state for inline file/folder creation. Pierre doesn't
 * have a first-class "draft" API — the official pattern is
 * `model.add(placeholder) + model.startRenaming(placeholder, {removeIfCanceled: true})`.
 * This hook wraps that pattern so the main `FileTree` doesn't have to
 * juggle the ref + onMutation cleanup + create-vs-rename branching.
 *
 * Pierre lifecycle (handled here):
 *  - Escape / blur-with-empty-input → controller removes the placeholder
 *  - Enter with empty/whitespace → controller removes the placeholder
 *  - Enter with text → controller calls `onRename`; `tryHandleAsCreate`
 *    detects the draft path and routes to `createFile`/`createFolder`.
 */
export function useFileTreeDraft({
  model,
  projectId,
  featureId,
  mutations,
  onFileCreated,
  featureKey,
}: UseFileTreeDraftOptions): UseFileTreeDraftResult {
  const draftRef = useRef<DraftState | null>(null);
  useDraftLifecycle(model, featureKey, draftRef);
  const startCreate = useStartCreate(model, draftRef);

  const isDraftPath = useCallback(
    (pierrePath: string | null) =>
      pierrePath != null && pierrePath === draftRef.current?.pierrePath,
    [],
  );

  const tryHandleAsCreate = useCallback(
    (event: FileTreeRenameEvent): boolean => {
      const draft = draftRef.current;
      if (draft == null || fromPierrePath(event.sourcePath) !== fromPierrePath(draft.pierrePath)) {
        return false;
      }

      const newName = typedEntryName(event.destinationPath);

      // Validate first; pierre has already locally moved the placeholder
      // to `pierreDest` at this point, so on bad input we clean it up.
      const validationError = validateSimpleName(newName);
      if (validationError) {
        toast.error(validationError);
        draftRef.current = null;
        removeDraftFromModel(model, event.destinationPath, draft.kind);
        return true;
      }

      draftRef.current = null;
      const onCreateError = () => {
        removeDraftFromModel(model, event.destinationPath, draft.kind);
      };
      const childPath = draft.parentDir ? `${draft.parentDir}/${newName}` : newName;
      const requestBase = { project_id: projectId, feature_id: featureId } as const;
      if (draft.kind === "file") {
        mutations.createFile.mutate(
          { data: { ...requestBase, file_path: childPath } },
          {
            onSuccess: (response) => {
              addConfirmedCreateToModel(model, response.path, draft.kind);
              onFileCreated(response.path);
            },
            onError: onCreateError,
          },
        );
      } else {
        mutations.createFolder.mutate(
          { data: { ...requestBase, dir_path: childPath } },
          {
            onSuccess: (response) => addConfirmedCreateToModel(model, response.path, draft.kind),
            onError: onCreateError,
          },
        );
      }
      queueMicrotask(() => removeDraftFromModel(model, event.destinationPath, draft.kind));
      return true;
    },
    [featureId, model, mutations.createFile, mutations.createFolder, onFileCreated, projectId],
  );

  return { startCreate, isDraftPath, tryHandleAsCreate };
}
