import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  useCreateEditorFile,
  useCreateEditorFolder,
  useRenameEditorPath,
  useMoveEditorPath,
  useTrashEditorPath,
  useGetEditorRoot,
} from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { desktopBridge } from "@/lib/desktop-bridge";
import { invalidateByExactUrl, invalidateByUrlPrefix, queryClient } from "@/lib/queryClient";

export type FileTreeMutations = ReturnType<typeof useFileTreeMutations>;

/**
 * Centralized mutations for file-tree edit operations and the
 * "Reveal in Finder" desktop command. Every mutation invalidates the
 * `/api/editor/tree` cache on success so the tree refreshes via the
 * canonical refetch (no optimistic updates — see `no-optimistic-updates.md`).
 * Errors surface as sonner toasts (see `error-handling.md`).
 *
 * The prefix `"/api/editor/tree"` covers both the per-directory `tree` query
 * (still used by ad-hoc callers) and the recursive `tree-all` query the
 * pierre file tree reads from.
 *
 * In lazy mode (giant repos, where `tree-all` is disabled and the tree loads
 * per-directory), we invalidate only the exact per-directory `tree` queries so
 * mutations refresh the affected folders without re-triggering the disabled
 * `tree-all` / `tree-count` queries.
 */
export function useFileTreeMutations(projectId: number, featureId: number, lazyMode = false) {
  const qc = useQueryClient();

  function invalidateTree(): Promise<void> {
    return lazyMode
      ? invalidateByExactUrl(qc, "/api/editor/tree")
      : invalidateByUrlPrefix(qc, "/api/editor/tree");
  }

  const createFile = useCreateEditorFile({
    mutation: {
      onSuccess: () => {
        void invalidateTree();
        toast.success("File created");
      },
      onError: (err) => toast.error(apiErrorMessage(err, "Failed to create file")),
    },
  });

  const createFolder = useCreateEditorFolder({
    mutation: {
      onSuccess: () => {
        void invalidateTree();
        toast.success("Folder created");
      },
      onError: (err) => toast.error(apiErrorMessage(err, "Failed to create folder")),
    },
  });

  const rename = useRenameEditorPath({
    mutation: {
      onSuccess: () => {
        void invalidateTree();
      },
      onError: (err) => toast.error(apiErrorMessage(err, "Failed to rename")),
    },
  });

  const move = useMoveEditorPath({
    mutation: {
      onSuccess: () => {
        void invalidateTree();
      },
      onError: (err) => toast.error(apiErrorMessage(err, "Failed to move")),
    },
  });

  const trash = useTrashEditorPath({
    mutation: {
      onSuccess: () => {
        void invalidateTree();
        toast.success("Moved to trash");
      },
      onError: (err) => toast.error(apiErrorMessage(err, "Failed to move to trash")),
    },
  });

  // Lazily fetch (and cache) the editor root so we can build absolute paths
  // for the native "Reveal in Finder" command.
  const rootQuery = useGetEditorRoot(
    { project_id: projectId, feature_id: featureId },
    { query: { staleTime: 60_000 } },
  );

  const reveal = useCallback(
    async (relativePath: string) => {
      try {
        const root = rootQuery.data?.root;
        if (!root) {
          toast.error("Editor root unavailable");
          return;
        }
        const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
        const absolute = root.endsWith(sep)
          ? `${root}${relativePath}`
          : `${root}${sep}${relativePath}`;
        await desktopBridge.revealInFinder(absolute);
      } catch (err) {
        toast.error(typeof err === "string" ? err : "Failed to reveal in file manager");
      }
    },
    [rootQuery.data?.root],
  );

  // Memoize the return so consumers get stable refs and downstream
  // `React.memo` actually short-circuits.
  return useMemo(
    () => ({ createFile, createFolder, rename, move, trash, reveal }),
    [createFile, createFolder, rename, move, trash, reveal],
  );
}

/**
 * Re-export to allow non-React callers (e.g. WS handlers) to invalidate the
 * editor tree.
 */
export function invalidateEditorTree(): Promise<void> {
  return invalidateByUrlPrefix(queryClient, "/api/editor/tree");
}
