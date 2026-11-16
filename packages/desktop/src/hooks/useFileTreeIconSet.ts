import { useMemo } from "react";
import { useSetting } from "@/hooks/useSetting";

/**
 * Workspace-scoped icon set for the @pierre/trees-based file tree. Mirrors
 * `FileTreeBuiltInIconSet` from `@pierre/trees`; redeclared locally so the
 * setting hook stays decoupled from the renderer.
 */
export type FileTreeIconSet = "minimal" | "standard" | "complete";

/** Persisted workspace key. Allowlisted in `settings_allowlist.rs`. */
export const FILE_TREE_ICON_SET_KEY = "editor_file_tree_icon_set";

/** Default when the user has never written the setting. */
export const DEFAULT_FILE_TREE_ICON_SET: FileTreeIconSet = "standard";

const ALLOWED: readonly FileTreeIconSet[] = ["minimal", "standard", "complete"] as const;

function parseIconSet(raw: string | null): FileTreeIconSet {
  if (!raw) return DEFAULT_FILE_TREE_ICON_SET;
  return (ALLOWED as readonly string[]).includes(raw)
    ? (raw as FileTreeIconSet)
    : DEFAULT_FILE_TREE_ICON_SET;
}

interface UseFileTreeIconSetResult {
  iconSet: FileTreeIconSet;
  setIconSet: (next: FileTreeIconSet) => void;
  isLoading: boolean;
}

/**
 * Read/write the global file-tree icon set. Routed through the same
 * debounced workspace-settings plumbing every other UI preference uses so
 * the picker feels instant and the value survives reload.
 */
export function useFileTreeIconSet(): UseFileTreeIconSetResult {
  const { value, setValue, isLoading } = useSetting(FILE_TREE_ICON_SET_KEY);
  return useMemo<UseFileTreeIconSetResult>(
    () => ({ iconSet: parseIconSet(value), setIconSet: setValue, isLoading }),
    [value, setValue, isLoading],
  );
}
