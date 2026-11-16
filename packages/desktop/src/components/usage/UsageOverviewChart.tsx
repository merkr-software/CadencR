import { cn } from "@/lib/utils";
import type { UsageDensity } from "./usage-cell-grid";
import { UsagePlotPlaceholder } from "./UsagePlotPlaceholder";
import { UsageTimelineChart } from "./UsageTimelineChart";
import type { UsageChartData, UsageMetric, UsageScale } from "./usage-stats-model";

/**
 * The timeline, or a box its size saying why it is empty. There can be usage
 * and still nothing to chart: output tokens over a window of input-only rows,
 * or messages over a window of tokens only.
 */
export function UsageOverviewChart({
  chart,
  labelOf,
  density,
  scale,
  metric,
  windowDays,
  emptyText,
}: {
  chart: UsageChartData;
  labelOf: (seriesKey: string) => string;
  density: UsageDensity;
  scale: UsageScale;
  metric: UsageMetric;
  windowDays: number;
  emptyText: string;
}): React.JSX.Element {
  if (chart.max > 0) {
    return (
      <UsageTimelineChart
        data={chart}
        labelOf={labelOf}
        density={density}
        scale={scale}
        metric={metric}
      />
    );
  }
  return (
    <UsagePlotPlaceholder
      days={windowDays}
      density={density}
      className={cn(
        "grid place-items-center rounded-lg border border-dashed border-border/60 text-center text-muted-foreground",
        density === "compact" ? "px-4 text-[11px]" : "px-6 text-xs",
      )}
    >
      {emptyText}
    </UsagePlotPlaceholder>
  );
}
