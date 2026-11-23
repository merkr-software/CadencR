import { useCallback, useMemo, useRef, useState } from "react";
import { isLargeDiffByLines } from "@/lib/diff-thresholds";

/** Minimal per-file shape the auto-collapse rule reads from the changed-files list. */
export interface CollapsibleFile {
  file: string;
  additions: number;
  deletions: number;
}

interface CollapseOverrideState {
  /** Diff file-set signature that `expandedLargeFiles` applies to. */
  signature: string;
  /** Large files the user explicitly expanded in the current diff. */
  expandedLargeFiles: ReadonlySet<string>;
  /** Files explicitly collapsed by user action or viewed-file initialization. */
  explicitlyCollapsed: ReadonlySet<string>;
}

interface CollapseContext {
  signature: string;
  largeFilePaths: ReadonlySet<string>;
}

const EMPTY_STRING_SET: ReadonlySet<string> = new Set();

const INITIAL_OVERRIDE_STATE: CollapseOverrideState = {
  signature: "",
  expandedLargeFiles: EMPTY_STRING_SET,
  explicitlyCollapsed: EMPTY_STRING_SET,
};

function currentExpandedLarge(prev: CollapseOverrideState, signature: string): ReadonlySet<string> {
  return prev.signature === signature ? prev.expandedLargeFiles : EMPTY_STRING_SET;
}

function isFileCollapsed(
  prev: CollapseOverrideState,
  ctx: CollapseContext,
  filePath: string,
): boolean {
  if (prev.explicitlyCollapsed.has(filePath)) return true;
  return (
    ctx.largeFilePaths.has(filePath) && !currentExpandedLarge(prev, ctx.signature).has(filePath)
  );
}

function applyCollapseFiles(
  prev: CollapseOverrideState,
  ctx: CollapseContext,
  filePaths: Iterable<string>,
): CollapseOverrideState {
  const prevExpandedLarge = currentExpandedLarge(prev, ctx.signature);
  let nextCollapsed: Set<string> | null = null;
  let nextExpandedLarge: Set<string> | null = null;
  for (const filePath of filePaths) {
    // Large files collapse by removing them from `expandedLargeFiles`, so they
    // aren't stuck in `explicitlyCollapsed` if they later shrink below threshold.
    if (
      !ctx.largeFilePaths.has(filePath) &&
      !(nextCollapsed ?? prev.explicitlyCollapsed).has(filePath)
    ) {
      nextCollapsed ??= new Set(prev.explicitlyCollapsed);
      nextCollapsed.add(filePath);
    }
    if ((nextExpandedLarge ?? prevExpandedLarge).has(filePath)) {
      nextExpandedLarge ??= new Set(prevExpandedLarge);
      nextExpandedLarge.delete(filePath);
    }
  }
  if (nextCollapsed === null && nextExpandedLarge === null) return prev;
  return {
    signature: ctx.signature,
    explicitlyCollapsed: nextCollapsed ?? prev.explicitlyCollapsed,
    expandedLargeFiles: nextExpandedLarge ?? prevExpandedLarge,
  };
}

function applyExpandFile(
  prev: CollapseOverrideState,
  ctx: CollapseContext,
  filePath: string,
): CollapseOverrideState {
  if (!isFileCollapsed(prev, ctx, filePath)) return prev;
  const prevExpandedLarge = currentExpandedLarge(prev, ctx.signature);
  let nextCollapsed = prev.explicitlyCollapsed;
  if (prev.explicitlyCollapsed.has(filePath)) {
    const cloned = new Set(prev.explicitlyCollapsed);
    cloned.delete(filePath);
    nextCollapsed = cloned;
  }
  let nextExpandedLarge = prevExpandedLarge;
  if (ctx.largeFilePaths.has(filePath) && !prevExpandedLarge.has(filePath)) {
    const cloned = new Set(prevExpandedLarge);
    cloned.add(filePath);
    nextExpandedLarge = cloned;
  }
  return {
    signature: ctx.signature,
    explicitlyCollapsed: nextCollapsed,
    expandedLargeFiles: nextExpandedLarge,
  };
}

function applyToggleFile(
  prev: CollapseOverrideState,
  ctx: CollapseContext,
  filePath: string,
): CollapseOverrideState {
  return isFileCollapsed(prev, ctx, filePath)
    ? applyExpandFile(prev, ctx, filePath)
    : applyCollapseFiles(prev, ctx, [filePath]);
}

export interface FileCollapseState {
  collapsedFiles: ReadonlySet<string>;
  collapseFile: (filePath: string) => void;
  collapseFiles: (filePaths: Iterable<string>) => void;
  expandFile: (filePath: string) => void;
  toggleFile: (filePath: string) => void;
}

/**
 * Manages per-file collapsed state with synchronous default collapse for large
 * files (`isLargeDiffByLines`).
 *
 * Computing large-file collapse synchronously during render (rather than in a
 * post-render `useEffect`) prevents huge files from rendering expanded on frame
 * 1 and immediately firing per-file diff fetches. Explicit user expansions of
 * large files are scoped to the current file-set signature so switching diffs
 * re-collapses large files without fighting the user within the same diff.
 */
export function useFileCollapseState(files: readonly CollapsibleFile[]): FileCollapseState {
  const [overrides, setOverrides] = useState<CollapseOverrideState>(INITIAL_OVERRIDE_STATE);

  const signature = useMemo(
    () => (files.length === 0 ? "" : files.map((f) => f.file).join("\n")),
    [files],
  );
  const largeFilePaths = useMemo<ReadonlySet<string>>(() => {
    let set: Set<string> | null = null;
    for (const file of files) {
      if (isLargeDiffByLines(file.additions, file.deletions)) {
        set ??= new Set();
        set.add(file.file);
      }
    }
    return set ?? EMPTY_STRING_SET;
  }, [files]);

  const contextRef = useRef<CollapseContext>({ signature, largeFilePaths });
  contextRef.current = { signature, largeFilePaths };

  const collapsedFiles = useMemo<ReadonlySet<string>>(() => {
    if (largeFilePaths.size === 0) return overrides.explicitlyCollapsed;
    const expandedLarge = currentExpandedLarge(overrides, signature);
    const next = new Set(overrides.explicitlyCollapsed);
    for (const filePath of largeFilePaths) {
      if (!expandedLarge.has(filePath)) next.add(filePath);
    }
    return next;
  }, [largeFilePaths, overrides, signature]);

  const collapseFile = useCallback(
    (filePath: string): void =>
      setOverrides((prev) => applyCollapseFiles(prev, contextRef.current, [filePath])),
    [],
  );
  const collapseFiles = useCallback(
    (filePaths: Iterable<string>): void =>
      setOverrides((prev) => applyCollapseFiles(prev, contextRef.current, filePaths)),
    [],
  );
  const expandFile = useCallback(
    (filePath: string): void =>
      setOverrides((prev) => applyExpandFile(prev, contextRef.current, filePath)),
    [],
  );
  const toggleFile = useCallback(
    (filePath: string): void =>
      setOverrides((prev) => applyToggleFile(prev, contextRef.current, filePath)),
    [],
  );

  return useMemo(
    () => ({ collapsedFiles, collapseFile, collapseFiles, expandFile, toggleFile }),
    [collapseFile, collapseFiles, collapsedFiles, expandFile, toggleFile],
  );
}
