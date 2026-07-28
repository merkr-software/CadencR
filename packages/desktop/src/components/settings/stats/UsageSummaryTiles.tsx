import type { ReactNode } from "react";
import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { formatCompactTokens, formatExactNumber } from "./usage-chart-palette";

export interface UsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Display label of the provider with the most tokens exchanged. */
  topProvider: string | null;
  /** Display label of the busiest model + thinking level pairing. */
  topModel: string | null;
}

/**
 * The headline numbers, above the charts. `choosing-a-form.md`: a single value
 * with no shape to it is a stat tile, not a chart — the timelines below carry
 * the shape.
 */
export function UsageSummaryTiles({ summary }: { summary: UsageSummary }): React.JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      <Tile
        label="Input tokens"
        value={formatCompactTokens(summary.totalInputTokens)}
        title={`${formatExactNumber(summary.totalInputTokens)} input tokens`}
        icon={<ArrowUpRight className="size-3.5" />}
      />
      <Tile
        label="Output tokens"
        value={formatCompactTokens(summary.totalOutputTokens)}
        title={`${formatExactNumber(summary.totalOutputTokens)} output tokens`}
        icon={<ArrowDownLeft className="size-3.5" />}
      />
      <Tile label="Top provider" value={summary.topProvider ?? "—"} name />
      <Tile label="Top model" value={summary.topModel ?? "—"} name />
    </div>
  );
}

function Tile({
  label,
  value,
  title,
  icon,
  name = false,
}: {
  label: string;
  value: string;
  title?: string;
  icon?: ReactNode;
  /** A name rather than a number: wraps at a smaller size instead of being
   *  truncated, since "claude-opus-4-8 · High" clipped to "claude-o…" names
   *  nothing at all. */
  name?: boolean;
}): React.JSX.Element {
  return (
    <div className="min-w-0 rounded-lg border border-border/60 bg-card px-3 py-2.5">
      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
        {icon ? (
          <span aria-hidden className="shrink-0">
            {icon}
          </span>
        ) : null}
        <span className="truncate">{label}</span>
      </div>
      <div
        className={
          name
            ? "mt-0.5 text-sm font-semibold leading-tight break-words"
            : "mt-0.5 truncate text-lg font-semibold tabular-nums"
        }
        title={title ?? value}
      >
        {value}
      </div>
    </div>
  );
}
