import { useGetUsageStats, type UsageStatsEntry } from "@/api/generated";
import { UsageOverviewChart } from "@/components/usage/UsageOverviewChart";
import { UsagePlotSkeleton } from "@/components/usage/UsagePlotPlaceholder";
import {
  UsageSegmentedControl,
  type SegmentedOption,
} from "@/components/usage/UsageSegmentedControl";
import { useUsageCharts } from "@/components/usage/use-usage-charts";
import { resolveEndDay, USAGE_METRIC_UNIT } from "@/components/usage/usage-stats-model";
import { apiErrorMessage } from "@/lib/api-errors";
import { capitalize } from "@/lib/utils";
import { type SessionUsageMetric, useSessionUsageMetric } from "./session-usage-measure";

/**
 * Trailing window of the overview. Equal to the Settings "30d" range on
 * purpose: both read `{ days: 30 }`, so React Query serves one request to both.
 */
const OVERVIEW_DAYS = 30;

const NO_ENTRIES: UsageStatsEntry[] = [];

const METRIC_OPTIONS = [
  { value: "messages", label: "Messages", title: "Prompts you sent, by the model they went to" },
  { value: "total", label: "Tokens", title: "Input plus output tokens" },
] as const satisfies readonly SegmentedOption<SessionUsageMetric>[];

/**
 * Last-30-days usage, one stacked series per provider + model, shown on the
 * empty session above the tips: messages sent by default, tokens on demand. A
 * caption names the unit; each day's breakdown is in its column's card.
 *
 * Renders nothing when there is no usage of either kind yet, so a new install
 * keeps the tips as the whole empty state. Loading and failure are both
 * visible — a missing chart must never read as "no usage".
 */
export function SessionUsageChart(): React.JSX.Element | null {
  const { data, isLoading, error } = useGetUsageStats({ days: OVERVIEW_DAYS });
  const [metric, setMetric] = useSessionUsageMetric();
  const { chart, labelOf, summary } = useUsageCharts({
    entries: data?.entries ?? NO_ENTRIES,
    windowDays: OVERVIEW_DAYS,
    endDay: resolveEndDay(data?.end_day),
    metric,
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

  if (!summary.hasUsage) return null;

  const unit = USAGE_METRIC_UNIT[metric];
  const caption = `${capitalize(unit)} over the last ${OVERVIEW_DAYS} days`;

  return (
    <section aria-label={caption} className="w-full space-y-2">
      {error ? (
        <p role="status" className="text-[11px] text-muted-foreground">
          Could not refresh usage. Showing the last loaded data.{" "}
          {apiErrorMessage(error, "Please try again.")}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-[11px] text-muted-foreground">{caption}</p>
        <UsageSegmentedControl
          value={metric}
          options={METRIC_OPTIONS}
          onChange={setMetric}
          ariaLabel="Chart measure"
          className="shrink-0"
        />
      </div>
      <UsageOverviewChart
        chart={chart}
        labelOf={labelOf}
        density="compact"
        scale="absolute"
        metric={metric}
        windowDays={OVERVIEW_DAYS}
        emptyText={`No ${unit} in the last ${OVERVIEW_DAYS} days.`}
      />
    </section>
  );
}
