import { memo, useEffect, useRef, type ReactElement } from "react";
import { Loader2Icon, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { HistoryGap } from "@/types/agent-stream";
import {
  HISTORY_GAP_ATTRIBUTE,
  HISTORY_GAP_HAS_ABOVE_ATTRIBUTE,
} from "./agent-session-scroll-utils";
import type { HistoryGapStatus } from "./useHistoryGapFiller";

interface HistoryGapRowProps {
  gap: HistoryGap;
  status: HistoryGapStatus | null;
  spaceBelow?: number;
}

/**
 * Saved history between two loaded rows that is not loaded yet. Says so in the
 * transcript's divider grammar instead of letting the rows on either side read
 * as consecutive, and loads itself as it nears the viewport: mounting (Virtuoso
 * mounts rows a screen or so ahead) registers it with the gap filler. While a programmatic
 * jump settles, it waits; after a failure it says why and offers a retry.
 */
export const HistoryGapRow = memo(function HistoryGapRow({
  gap,
  status,
  spaceBelow,
}: HistoryGapRowProps): ReactElement {
  const rowRef = useRef<HTMLDivElement>(null);
  const trackRow = status?.trackRow;
  useEffect(() => {
    const row = rowRef.current;
    if (!row || !trackRow) return;
    return trackRow(row);
  }, [trackRow]);
  const loading = status?.fillingGapId === gap.id;
  const failure = status?.failures.get(gap.id) ?? null;
  return (
    <div
      ref={rowRef}
      {...{
        [HISTORY_GAP_ATTRIBUTE]: gap.id,
        [HISTORY_GAP_HAS_ABOVE_ATTRIBUTE]: gap.afterId === null ? undefined : "",
      }}
      style={spaceBelow === undefined ? undefined : { paddingBottom: spaceBelow }}
    >
      <div
        role={failure ? "alert" : "status"}
        aria-busy={loading}
        className="flex h-6 min-w-0 items-center gap-3 text-xs text-muted-foreground"
      >
        <span className="h-px min-w-6 flex-1 bg-border/70" aria-hidden />
        {failure ? (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <TriangleAlert className="size-3.5 shrink-0 text-destructive" aria-hidden />
            <span className="shrink-0 font-medium text-destructive">
              Couldn't load these messages
            </span>
            <span className="min-w-0 truncate" title={failure}>
              {failure}
            </span>
          </span>
        ) : (
          <span className="inline-flex shrink-0 items-center gap-1.5">
            {loading ? <Loader2Icon className="size-3 animate-spin" aria-hidden /> : null}
            {loading ? "Loading messages…" : "Messages not loaded yet"}
          </span>
        )}
        {failure && status ? (
          <Button
            type="button"
            variant="link"
            size="xs"
            className="h-auto shrink-0 p-0"
            onClick={status.retry}
          >
            Retry
          </Button>
        ) : null}
        <span className="h-px min-w-6 flex-1 bg-border/70" aria-hidden />
      </div>
    </div>
  );
});
