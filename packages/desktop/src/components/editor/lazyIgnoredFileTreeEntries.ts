import { useCallback, useMemo } from "react";
import type { FileTree as FileTreeModel } from "@pierre/trees";
import type { FileTreeEntry } from "@/api/generated";
import {
  ROOT_DIR,
  useLazyDirectoryEntries,
  type DirectoryQueryResult,
} from "./useLazyDirectoryEntries";

interface UseLazyIgnoredFileTreeEntriesOptions {
  model: FileTreeModel;
  projectId: number;
  featureId: number;
  trackedEntries: readonly FileTreeEntry[] | undefined;
  onEntriesChange: (entries: readonly FileTreeEntry[]) => void;
  /** Off in lazy-tracked mode, where the whole tree loads on demand instead. */
  enabled?: boolean;
}

/**
 * Gitignored directory paths whose contents should load lazily on expand.
 * Unions the fast `tracked` query with the lazily-fetched entries: a
 * tracked-but-ignored directory (issue #41) is surfaced by the backend in
 * the tracked query, so it never lands in `lazyEntries` — yet expanding it
 * must still pull in its untracked ignored children.
 */
export function knownIgnoredDirectoryPaths(
  trackedEntries: readonly FileTreeEntry[] | undefined,
  lazyEntries: readonly FileTreeEntry[],
): readonly string[] {
  const paths = new Set<string>();
  for (const entry of trackedEntries ?? []) {
    if (entry.is_dir && entry.is_gitignored) paths.add(entry.path);
  }
  for (const entry of lazyEntries) {
    if (entry.is_dir && entry.is_gitignored) paths.add(entry.path);
  }
  return [...paths];
}

export function mergeFileTreeEntries(
  trackedEntries: readonly FileTreeEntry[] | undefined,
  lazyIgnoredEntries: readonly FileTreeEntry[],
): readonly FileTreeEntry[] | undefined {
  if (trackedEntries == null) return lazyIgnoredEntries.length > 0 ? lazyIgnoredEntries : undefined;
  if (lazyIgnoredEntries.length === 0) return trackedEntries;

  const seen = new Set<string>();
  const merged: FileTreeEntry[] = [];
  for (const entry of trackedEntries) {
    seen.add(entry.path);
    merged.push(entry);
  }
  for (const entry of lazyIgnoredEntries) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    merged.push(entry);
  }
  return merged;
}

export function collectLazyIgnoredEntries(
  queryResults: readonly DirectoryQueryResult[],
  trackedEntries: readonly FileTreeEntry[] | undefined,
): readonly FileTreeEntry[] {
  const trackedPaths = new Set((trackedEntries ?? []).map((entry) => entry.path));
  const seen = new Set<string>();
  const entries: FileTreeEntry[] = [];

  for (const result of queryResults) {
    for (const entry of result.entries ?? []) {
      if (trackedPaths.has(entry.path) || seen.has(entry.path)) continue;
      if (result.dirPath === ROOT_DIR && !entry.is_gitignored) continue;
      seen.add(entry.path);
      entries.push(result.dirPath === ROOT_DIR ? entry : { ...entry, is_gitignored: true });
    }
  }
  return entries;
}

/**
 * Lazily loads the contents of gitignored directories (`node_modules`,
 * `target`, …) the first time the user expands them, so the fast tracked
 * tree never has to walk them. A thin specialization of the generic
 * `useLazyDirectoryEntries`: it watches the gitignored directories and shapes
 * each loaded entry as ignored.
 */
export function useLazyIgnoredFileTreeEntries({
  model,
  projectId,
  featureId,
  trackedEntries,
  onEntriesChange,
  enabled = true,
}: UseLazyIgnoredFileTreeEntriesOptions): void {
  const expandableDirectoryPaths = useMemo(
    () => knownIgnoredDirectoryPaths(trackedEntries, []),
    [trackedEntries],
  );

  const collectEntries = useCallback(
    (queryResults: readonly DirectoryQueryResult[]) =>
      collectLazyIgnoredEntries(queryResults, trackedEntries),
    [trackedEntries],
  );

  useLazyDirectoryEntries({
    model,
    projectId,
    featureId,
    enabled,
    expandableDirectoryPaths,
    directoryPredicate: isIgnoredDirectory,
    collectEntries,
    onEntriesChange,
  });
}

function isIgnoredDirectory(entry: FileTreeEntry): boolean {
  return entry.is_dir && entry.is_gitignored;
}
