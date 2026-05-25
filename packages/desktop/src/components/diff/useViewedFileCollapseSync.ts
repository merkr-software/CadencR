import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";

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
