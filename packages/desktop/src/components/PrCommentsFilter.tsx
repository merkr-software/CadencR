import type { ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type PrCommentFilter = "unresolved" | "all";

/**
 * Defaults to `unresolved` everywhere. A review's resolved threads are settled
 * history; what a developer opens this tab for is the work still outstanding,
 * and the toggle keeps the rest one click away rather than buried.
 */
export const DEFAULT_PR_COMMENT_FILTER: PrCommentFilter = "unresolved";

export function PrCommentsFilterToggle({
  value,
  unresolvedCount,
  totalCount,
  onChange,
}: {
  value: PrCommentFilter;
  unresolvedCount: number;
  totalCount: number;
  onChange: (next: PrCommentFilter) => void;
}): ReactElement {
  return (
    <div
      role="group"
      aria-label="Filter review threads"
      className="inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-border bg-card/70 p-0.5"
    >
      <FilterButton
        active={value === "unresolved"}
        label="Unresolved"
        count={unresolvedCount}
        onClick={() => onChange("unresolved")}
      />
      <FilterButton
        active={value === "all"}
        label="All"
        count={totalCount}
        onClick={() => onChange("all")}
      />
    </div>
  );
}

function FilterButton({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}): ReactElement {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "px-2 text-[11px] font-medium",
        // The Git view toggle's grammar: a raised thumb in a recessed track.
        // An `--accent` fill was one step off the track in the dark theme and
        // invisible in the light one, so the active filter went unread.
        active
          ? "bg-background text-foreground shadow-xs ring-1 ring-border/70 hover:bg-background"
          : "text-muted-foreground",
      )}
    >
      {label} <span className="tabular-nums opacity-70">{count}</span>
    </Button>
  );
}
