import { useGetUsageStats, type UsageStatsEntry } from "@/api/generated";
import { UsagePlotSkeleton } from "@/components/settings/stats/UsagePlotPlaceholder";
import { UsageTimelineChart } from "@/components/settings/stats/UsageTimelineChart";
import { useUsageCharts } from "@/components/settings/stats/use-usage-charts";
import { resolveEndDay, USAGE_METRIC_UNIT } from "@/components/settings/stats/usage-stats-model";
import { apiErrorMessage } from "@/lib/api-errors";

/**
 * Trailing window of the overview. Equal to the Settings "30d" range on
 * purpose: both read `{ days: 30 }`, so React Query serves one request to both.
 */
const OVERVIEW_DAYS = 30;

const NO_ENTRIES: UsageStatsEntry[] = [];

/**
 * Last-30-days usage, one stacked series per provider + model, shown on the
 * empty session above the tips. The grid alone: each day's breakdown is in its
 * column's card.
 *
 * Renders nothing when there is no usage yet, so a new install keeps the tips
 * as the whole empty state. Loading and failure are both visible — a missing
 * chart must never read as "no usage".
 */
export function SessionUsageChart(): React.JSX.Element | null {
  const { data, isLoading, error } = useGetUsageStats({ days: OVERVIEW_DAYS });
  const { chart } = useUsageCharts({
    entries: data?.entries ?? NO_ENTRIES,
    windowDays: OVERVIEW_DAYS,
    endDay: resolveEndDay(data?.end_day),
    metric: "total",
    grouping: "model",
  });

  if (!data) {
    if (isLoading) return <UsagePlotSkeleton days={OVERVIEW_DAYS} density="compact" />;
    if (error) {
      return (
        <p role="status" className="w-full text-center text-xs text-muted-foreground">
          Usage is unavailable right now. {apiErrorMessage(error, "Please try again.")}
        </p>
      );
    }
    return null;
  }

  if (chart.max === 0) return null;

  return (
    <section aria-label="Usage over the last 30 days" className="w-full space-y-2">
      {error ? (
        <p role="status" className="text-[11px] text-muted-foreground">
          Could not refresh usage. Showing the last loaded data.{" "}
          {apiErrorMessage(error, "Please try again.")}
        </p>
      ) : null}
      <UsageTimelineChart
        data={chart}
        density="compact"
        scale="absolute"
        metricLabel={USAGE_METRIC_UNIT.total}
      />
    </section>
  );
}
