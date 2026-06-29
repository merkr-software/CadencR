import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { ParsedFileMeta } from "@/lib/parse-unified-diff";

// Files whose changed-line count exceeds this are collapsed by default on a
// fresh diff. Rendering a single very large file through Pierre is a
// synchronous main-thread cost (tokenize + a large `innerHTML` write) that
// janks the Git tab on open — most painful for "vs main" diffs that include
// generated files. The file still appears with its +/- counts; expanding it
// renders on demand.
const LARGE_FILE_AUTO_COLLAPSE_LINES = 1000;

/**
 * Collapse very large files when a new diff loads so a single giant file
 * doesn't block the main thread rendering through Pierre on open. Keyed on the
 * file-set signature so it re-applies once per diff but never fights the user
 * re-expanding a large file within the same diff.
 */
export function useCollapseLargeFilesOnLoad(
  fileMeta: ParsedFileMeta[],
  fileNames: string[],
  setCollapsedFiles: Dispatch<SetStateAction<Set<string>>>,
): void {
  const signatureRef = useRef<string | null>(null);

  useEffect(() => {
    if (fileMeta.length === 0) return;
    const signature = fileNames.join("\n");
    if (signatureRef.current === signature) return;
    signatureRef.current = signature;

    const largeFiles = fileMeta
      .filter((meta) => meta.additions + meta.deletions > LARGE_FILE_AUTO_COLLAPSE_LINES)
      .map((meta) => meta.displayName);
    if (largeFiles.length === 0) return;

    setCollapsedFiles((prev) => new Set([...prev, ...largeFiles]));
  }, [fileMeta, fileNames, setCollapsedFiles]);
}

export function useExpandFilesWhenViewedReset(
  viewedFilesSet: Set<string>,
  setCollapsedFiles: Dispatch<SetStateAction<Set<string>>>,
): void {
  const previousViewedFilesRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const noLongerViewed = [...previousViewedFilesRef.current].filter(
      (fileName) => !viewedFilesSet.has(fileName),
    );
    previousViewedFilesRef.current = viewedFilesSet;
    if (noLongerViewed.length === 0) return;

    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      for (const fileName of noLongerViewed) {
        next.delete(fileName);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [viewedFilesSet, setCollapsedFiles]);
}
