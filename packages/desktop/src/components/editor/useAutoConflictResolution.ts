import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { FileStageState, useGetChangedFiles, type ChangedFileConflictKind } from "@/api/generated";
import { useGitPathPrefix } from "@/hooks/useGitPathPrefix";
import { apiErrorMessage } from "@/lib/api-errors";
import { gitPathToFeaturePath } from "@/lib/git-paths";

interface ConfirmedConflict {
  kind: ChangedFileConflictKind | undefined;
  /** The path Git endpoints know the file by, relative to the checkout root. */
  gitPath: string;
}

interface ConfirmedConflictPaths {
  byPath: ReadonlyMap<string, ConfirmedConflict>;
}

const ConfirmedConflictPathsContext = createContext<ConfirmedConflictPaths | null>(null);

/**
 * One changed-files observer per mounted feature editor. Consumers derive the
 * active path directly from this exact-path map instead of mirroring Git state
 * into every editor tab. Keys are editor paths (relative to the feature's
 * directory); conflicts outside that directory cannot be open in this editor.
 */
export function useConfirmedConflictPaths(featureId: number): ConfirmedConflictPaths {
  const changedFiles = useGetChangedFiles(
    { feature_id: featureId, mode: "worktree" },
    { query: { refetchOnMount: false, refetchOnWindowFocus: false } },
  );
  const prefix = useGitPathPrefix(featureId);

  useEffect(() => {
    if (!changedFiles.isError) return;
    toast.error("Could not detect Git conflicts", {
      description: apiErrorMessage(changedFiles.error, "Git status is unavailable"),
    });
  }, [changedFiles.error, changedFiles.isError]);

  return useMemo(() => {
    const byPath = new Map<string, ConfirmedConflict>();
    if (prefix == null) return { byPath };
    for (const file of changedFiles.data ?? []) {
      if (file.stage_state !== FileStageState.conflicted) continue;
      const editorPath = gitPathToFeaturePath(file.file, prefix);
      if (editorPath != null) {
        byPath.set(editorPath, { kind: file.conflict_kind, gitPath: file.file });
      }
    }
    return { byPath };
  }, [changedFiles.data, prefix]);
}

export function ConfirmedConflictPathsProvider({
  conflicts,
  children,
}: {
  conflicts: ConfirmedConflictPaths;
  children: ReactNode;
}): ReactNode {
  return createElement(ConfirmedConflictPathsContext.Provider, { value: conflicts }, children);
}

/**
 * Resolve one active path from watcher-confirmed changed-files. The sole local
 * latch retains a dirty Result after Git clears the unmerged row, preventing a
 * remount over unsaved edits; it disappears as soon as that Result is saved.
 */
export function useActiveConflict(
  filePath: string | null,
  isDirty: boolean,
): ConfirmedConflict | null {
  const conflicts = useContext(ConfirmedConflictPathsContext);
  const confirmed = filePath ? (conflicts?.byPath.get(filePath) ?? null) : null;
  const dirtyResultsByPath = useRef(new Map<string, ConfirmedConflict>());
  const dirtyResult = filePath ? (dirtyResultsByPath.current.get(filePath) ?? null) : null;

  useEffect(() => {
    if (!filePath) return;
    if (confirmed && isDirty) dirtyResultsByPath.current.set(filePath, confirmed);
    else if (!isDirty) dirtyResultsByPath.current.delete(filePath);
  }, [confirmed, filePath, isDirty]);

  return confirmed ?? (isDirty ? dirtyResult : null);
}
