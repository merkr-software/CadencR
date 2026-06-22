import { useCallback, useMemo, useRef } from "react";
import type { FileTree as FileTreeModel } from "@pierre/trees";
import { useFileTree as useFileTreeDir, type FileTreeEntry } from "@/api/generated";
import {
  ROOT_DIR,
  useLazyDirectoryEntries,
  type DirectoryQueryResult,
} from "./useLazyDirectoryEntries";

interface UseTrackedTreeDataOptions {
  model: FileTreeModel;
  projectId: number;
  featureId: number;
  /** Lazy mode is only active past the hybrid threshold; off keeps it inert. */
  enabled: boolean;
  /**
   * Push the loaded entries upward. Like the gitignored loader, entries flow
   * through the parent's state (not the return value) so `paths` can be
   * computed before the pierre model is built — the model dependency would
   * otherwise be circular. Must be stable.
   */
  onEntriesChange: (entries: readonly FileTreeEntry[]) => void;
}

export interface TrackedTreeData {
  isLoading: boolean;
  error: string | null;
  /** Imperatively fetch a directory's children (reveal-to-path). */
  ensureDirLoaded: (dirPath: string) => void;
}

/**
 * Expand-on-demand data source for the editor file tree on giant repos
 * (> `TREE_LAZY_THRESHOLD` tracked files), where loading the whole tracked
 * tree up front is too slow. The top level loads via `/api/editor/tree`
 * (`dir_path: "."`); each directory's children are fetched the first time it
 * is expanded — the same machinery the gitignored sub-tree loader uses, via
 * the shared `useLazyDirectoryEntries`.
 *
 * Every loaded directory is itself expandable, so the whole tree streams in
 * as the user drills down. Entries keep the backend's `is_gitignored` flag so
 * dimming still works.
 */
export function useTrackedTreeData({
  model,
  projectId,
  featureId,
  enabled,
  onEntriesChange,
}: UseTrackedTreeDataOptions): TrackedTreeData {
  const ensureRef = useRef<(dirPath: string) => void>(() => {});

  // The root query drives the tree's loading/error state. React Query dedupes
  // by key, so this shares the fetch the generic hook issues for the root.
  const rootQuery = useFileTreeDir(
    { project_id: projectId, feature_id: featureId, dir_path: ROOT_DIR },
    { query: { staleTime: 30_000, enabled } },
  );

  const collectEntries = useCallback(
    (queryResults: readonly DirectoryQueryResult[]): readonly FileTreeEntry[] =>
      collectTrackedEntries(queryResults),
    [],
  );

  const onEnsureDirLoaded = useCallback((ensure: (dirPath: string) => void) => {
    ensureRef.current = ensure;
  }, []);

  useLazyDirectoryEntries({
    model,
    projectId,
    featureId,
    enabled,
    // No externally-known dirs — every loaded directory is discovered via the
    // predicate below.
    expandableDirectoryPaths: EMPTY_STRINGS,
    directoryPredicate: isDirectory,
    collectEntries,
    onEntriesChange,
    onEnsureDirLoaded,
  });

  const ensureDirLoaded = useCallback((dirPath: string) => ensureRef.current(dirPath), []);

  return useMemo<TrackedTreeData>(
    () => ({
      isLoading: enabled && rootQuery.isLoading && !rootQuery.data,
      error: enabled && rootQuery.isError && !rootQuery.data ? "Failed to load file tree" : null,
      ensureDirLoaded,
    }),
    [enabled, ensureDirLoaded, rootQuery.data, rootQuery.isError, rootQuery.isLoading],
  );
}

/** Flatten every loaded directory's children, deduped. Entries keep their
 *  backend-reported `is_gitignored` flag so dimming is preserved. */
function collectTrackedEntries(
  queryResults: readonly DirectoryQueryResult[],
): readonly FileTreeEntry[] {
  const seen = new Set<string>();
  const entries: FileTreeEntry[] = [];
  for (const result of queryResults) {
    for (const entry of result.entries ?? []) {
      if (seen.has(entry.path)) continue;
      seen.add(entry.path);
      entries.push(entry);
    }
  }
  return entries;
}

function isDirectory(entry: FileTreeEntry): boolean {
  return entry.is_dir;
}

const EMPTY_STRINGS: readonly string[] = [];
