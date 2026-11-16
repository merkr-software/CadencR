import {
  formatChartTokens,
  formatCompactTokens,
  formatExactNumber,
} from "@/components/usage/usage-chart-palette";
import type { UsageSummary } from "@/components/usage/use-usage-charts";
import type { UsageMetric } from "@/components/usage/usage-stats-model";

/**
 * The headline numbers, above the chart. A single value with no shape to it is a
 * stat tile, not a chart: the grid below carries the shape. The first two tiles
 * follow the measure: tokens in and out, or messages sent and their daily rate.
 */
export function UsageSummaryTiles({
  summary,
  metric,
  windowDays,
}: {
  summary: UsageSummary;
  metric: UsageMetric;
  windowDays: number;
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      {metric === "messages" ? (
        <MessageTiles total={summary.totalUserMessages} windowDays={windowDays} />
      ) : (
        <TokenTiles summary={summary} />
      )}
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

function TokenTiles({ summary }: { summary: UsageSummary }): React.JSX.Element {
  return (
    <>
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
    </>
  );
}

function MessageTiles({
  total,
  windowDays,
}: {
  total: number;
  windowDays: number;
}): React.JSX.Element {
  const perDay = formatCompactTokens(total / Math.max(1, windowDays));
  return (
    <>
      <Tile
        label="Messages sent"
        value={formatExactNumber(total)}
        title={`${formatExactNumber(total)} messages sent`}
      />
      <Tile
        label="Daily average"
        value={perDay}
        title={`${perDay} messages a day over ${windowDays} days`}
      />
    </>
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
