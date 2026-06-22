import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import type { FileTree as FileTreeModel, FileTreeDirectoryHandle } from "@pierre/trees";
import { getFileTreeQueryOptions, type FileTreeEntry, type FileTreeParams } from "@/api/generated";
import { toPierrePath } from "@/components/file-tree/CadencrFileTree";

/** Per-directory `/api/editor/tree` result keyed by the directory it loaded. */
export interface DirectoryQueryResult {
  dirPath: string;
  entries: readonly FileTreeEntry[] | undefined;
}

interface UseLazyDirectoryEntriesOptions {
  model: FileTreeModel;
  projectId: number;
  featureId: number;
  /** When false, no queries are issued (the source is inactive). Default true. */
  enabled?: boolean;
  /**
   * Externally-known directory paths (FS-form) the user may expand to trigger
   * a child fetch — e.g. tracked-but-ignored dirs. The hook also self-discovers
   * further expandable directories from its own loaded entries via
   * `directoryPredicate`, so nested dirs become expandable as the user drills
   * in. The root (`.`) is always queried and must NOT be included here.
   */
  expandableDirectoryPaths: readonly string[];
  /**
   * Which loaded entries are themselves expandable directories. Returning true
   * lets the hook fetch their children when the user expands them.
   */
  directoryPredicate: (entry: FileTreeEntry) => boolean;
  /**
   * Map the raw per-directory query results into the flat entry list this
   * source contributes. Must be stable (wrap in `useCallback`) — it's a memo
   * dependency.
   */
  collectEntries: (queryResults: readonly DirectoryQueryResult[]) => readonly FileTreeEntry[];
  /** Push the collected entries upward; only called when they actually change. */
  onEntriesChange: (entries: readonly FileTreeEntry[]) => void;
  /** Imperatively load a directory's children (used by reveal-to-path). */
  onEnsureDirLoaded?: (ensure: (dirPath: string) => void) => void;
}

export const ROOT_DIR = ".";

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function entriesSignature(entries: readonly FileTreeEntry[]): string {
  return entries
    .map(
      (entry) => `${entry.path}\t${entry.is_dir ? "d" : "f"}\t${entry.is_gitignored ? "i" : "-"}`,
    )
    .join("\n");
}

/** Which of `directoryPaths` are currently expanded in the pierre model. */
function readExpandedDirectories(
  model: FileTreeModel,
  directoryPaths: readonly string[],
): readonly string[] {
  const expanded: string[] = [];
  for (const path of directoryPaths) {
    const item = model.getItem(toPierrePath({ path, is_dir: true }));
    if (item == null || !item.isDirectory()) continue;
    if ((item as FileTreeDirectoryHandle).isExpanded()) expanded.push(path);
  }
  return expanded;
}

/**
 * Generic expand-on-demand directory loader shared by the editor file tree's
 * two lazy modes: gitignored sub-trees inside an otherwise-full tree, and the
 * whole tracked tree on giant repos. It owns the expand-detection,
 * per-directory `useQueries`, and change emission; callers supply which
 * directories are expandable and how to shape the loaded entries.
 */
export function useLazyDirectoryEntries({
  model,
  projectId,
  featureId,
  enabled = true,
  expandableDirectoryPaths,
  directoryPredicate,
  collectEntries,
  onEntriesChange,
  onEnsureDirLoaded,
}: UseLazyDirectoryEntriesOptions): void {
  // Directories whose children we want loaded. Seeded from model expansion and
  // (optionally) forced open by `ensureDirLoaded` for reveal-to-path.
  const [requestedDirs, setRequestedDirs] = useState<readonly string[]>([]);
  const expandableRef = useRef<readonly string[]>([]);
  const forcedDirsRef = useRef<Set<string>>(new Set());
  const entriesSignatureRef = useRef("");
  const queryDirs = useMemo(() => [ROOT_DIR, ...requestedDirs], [requestedDirs]);

  const queries = useQueries({
    queries: queryDirs.map((dirPath) => {
      const params: FileTreeParams = {
        project_id: projectId,
        feature_id: featureId,
        dir_path: dirPath,
      };
      return getFileTreeQueryOptions(params, { query: { staleTime: 30_000, enabled } });
    }),
  });

  const queryDataVersion = queries
    .map((query, index) => `${queryDirs[index] ?? ROOT_DIR}:${query.dataUpdatedAt}`)
    .join(",");
  const collectedEntries = useMemo(() => {
    const queryResults: DirectoryQueryResult[] = queries.map((query, index) => ({
      dirPath: queryDirs[index] ?? ROOT_DIR,
      entries: query.data,
    }));
    return collectEntries(queryResults);
    // `queryDataVersion`/`queryDirs` capture the query inputs; `collectEntries`
    // is the (stable) transform. We deliberately omit `queries` so we react to
    // data changes, not the fresh array identity React Query returns each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectEntries, queryDataVersion, queryDirs]);

  // Externally-known expandable dirs ∪ those self-discovered in loaded entries
  // (so nested dirs become expandable as the user drills in).
  const expandableDirs = useMemo(() => {
    const dirs = new Set(expandableDirectoryPaths);
    for (const entry of collectedEntries) {
      if (directoryPredicate(entry)) dirs.add(entry.path);
    }
    return [...dirs];
  }, [collectedEntries, directoryPredicate, expandableDirectoryPaths]);

  // Recompute requested dirs from model expansion ∪ forced dirs.
  const syncRequested = useCallback((): void => {
    const expanded = readExpandedDirectories(model, expandableRef.current);
    const next = [...new Set([...expanded, ...forcedDirsRef.current])];
    setRequestedDirs((current) => (sameStringArray(current, next) ? current : next));
  }, [model]);

  useEffect(() => {
    expandableRef.current = expandableDirs;
    syncRequested();
  }, [expandableDirs, syncRequested]);

  useEffect(() => {
    syncRequested();
    return model.subscribe(syncRequested);
  }, [model, syncRequested]);

  useEffect(() => {
    const signature = entriesSignature(collectedEntries);
    if (entriesSignatureRef.current === signature) return;
    entriesSignatureRef.current = signature;
    onEntriesChange(collectedEntries);
  }, [collectedEntries, onEntriesChange]);

  // Expose an imperative "load this directory's children now" used by
  // reveal-to-path to pull in ancestors before expanding them.
  const ensureDirLoaded = useCallback(
    (dirPath: string): void => {
      if (dirPath === "" || dirPath === ROOT_DIR) return;
      if (forcedDirsRef.current.has(dirPath)) return;
      forcedDirsRef.current.add(dirPath);
      syncRequested();
    },
    [syncRequested],
  );
  useEffect(() => {
    onEnsureDirLoaded?.(ensureDirLoaded);
  }, [ensureDirLoaded, onEnsureDirLoaded]);
}
