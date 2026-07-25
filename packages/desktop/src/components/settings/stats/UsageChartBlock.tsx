import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { UsageChartLegend } from "./UsageChartLegend";
import { UsageTimelineChart } from "./UsageTimelineChart";
import type { UsageChartData } from "./usage-stats-model";

/**
 * One titled timeline: heading, its own filter control, the plot, and the
 * legend. Both charts on the Stats tab have this exact anatomy, so the header
 * row stays identical between them — filters sit above the plot, never inside.
 */
export function UsageChartBlock({
  title,
  control,
  data,
  metricLabel,
  emptyMessage,
  divided = false,
}: {
  title: string;
  /** Filter for this chart (measure, provider, …). */
  control: ReactNode;
  data: UsageChartData;
  metricLabel: string;
  emptyMessage: string;
  /** Draws the seam above the block when it follows another one. */
  divided?: boolean;
}): React.JSX.Element {
  return (
    <div className={cn("space-y-4", divided && "border-t border-border/50 pt-5")}>
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-xs font-medium text-foreground">{title}</h4>
        {control}
      </div>
      <div>
        <UsageTimelineChart data={data} metricLabel={metricLabel} emptyMessage={emptyMessage} />
        <UsageChartLegend series={data.series} />
      </div>
    </div>
  );
}
