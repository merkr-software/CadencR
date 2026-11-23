import type { ReactElement } from "react";
import { FileWarning } from "lucide-react";
import { formatBytes } from "@/lib/diff-thresholds";

/** The list footer when the backend capped the matches. */
export function TruncatedFooter(): ReactElement {
  return (
    <div className="py-2 text-center text-xs text-muted-foreground">
      Results capped at 500. Refine your search for more specific results.
    </div>
  );
}

/** Says how many files the search left out for their size: a match in one of
 *  them is missing from the results, "No results found." included. */
export function SkippedLargeFilesNotice({
  count,
  maxFileBytes,
}: {
  count: number;
  maxFileBytes: number;
}): ReactElement | null {
  if (count === 0) return null;
  const files = count === 1 ? "1 file" : `${count} files`;
  return (
    <div
      role="status"
      className="flex items-center gap-1.5 px-3 pb-1 text-[11px] text-muted-foreground"
    >
      <FileWarning aria-hidden className="size-3 shrink-0 text-[var(--acc-yellow)]" />
      {files} larger than {formatBytes(maxFileBytes)} not searched.
    </div>
  );
}
