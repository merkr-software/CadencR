import { useUiTranslation } from "@/lib/i18n/ui";
import type { ReactElement } from "react";
import { FileWarning } from "lucide-react";
import { formatBytes } from "@/lib/diff-thresholds";

/** The list footer when the backend capped the matches. */
export function TruncatedFooter(): ReactElement {
  const { t } = useUiTranslation();
  return (
    <div className="py-2 text-center text-xs text-muted-foreground">
      {t(
        "search.content.truncated",
        "Results capped at {{limit, number}}. Refine your search for more specific results.",
        { limit: 500 },
      )}
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
  const { t } = useUiTranslation();
  if (count === 0) return null;
  return (
    <div
      role="status"
      className="flex items-center gap-1.5 px-3 pb-1 text-[11px] text-muted-foreground"
    >
      <FileWarning aria-hidden className="size-3 shrink-0 text-[var(--acc-yellow)]" />
      {t("search.content.skipped", {
        count,
        size: formatBytes(maxFileBytes),
        defaultValue_one: "{{count, number}} file larger than {{size}} not searched.",
        defaultValue_other: "{{count, number}} files larger than {{size}} not searched.",
      })}
    </div>
  );
}
