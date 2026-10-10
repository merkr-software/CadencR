import { formatChartTokens, formatExactNumber } from "@/components/usage/usage-chart-palette";
import type { UsageSummary } from "@/components/usage/use-usage-charts";

/**
 * The headline numbers, above the chart. A single value with no shape to it is a
 * stat tile, not a chart: the grid below carries the shape.
 */
export function UsageSummaryTiles({ summary }: { summary: UsageSummary }): React.JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      <Tile
        label="Input"
        value={formatChartTokens(summary.totalInputTokens)}
        title={`${formatExactNumber(summary.totalInputTokens)} input tokens`}
      />
      <Tile
        label="Output"
        value={formatChartTokens(summary.totalOutputTokens)}
        title={`${formatExactNumber(summary.totalOutputTokens)} output tokens`}
      />
      <Tile label="Top provider" value={summary.topProvider ?? "None"} name />
      <Tile
        label="Top model"
        value={summary.topModel?.name ?? "None"}
        title={summary.topModel?.label}
        name
      />
    </div>
  );
}

function Tile({
  label,
  value,
  title,
  name = false,
}: {
  label: string;
  value: string;
  title?: string;
  /** A name rather than a figure: set smaller, so "claude-opus-5-5" fits a tile. */
  name?: boolean;
}): React.JSX.Element {
  return (
    <div className="min-w-0 rounded-lg border border-border/60 bg-card px-3 py-2.5">
      <div className="truncate text-[11px] text-muted-foreground">{label}</div>
      <div
        className={
          name
            ? "mt-0.5 line-clamp-2 break-words text-sm font-semibold leading-snug"
            : "mt-0.5 truncate text-lg font-semibold tabular-nums"
        }
        title={title ?? value}
      >
        {value}
      </div>
    </div>
  );
}
