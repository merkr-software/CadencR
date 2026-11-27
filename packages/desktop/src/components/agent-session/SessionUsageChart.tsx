import { formattingLocale } from "@/lib/i18n/formatting-locale";
import { formatExactNumber } from "@/lib/format-number";
import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { useGetUsageStats, type UsageStatsEntry } from "@/api/generated";
import { UsageOverviewChart } from "@/components/usage/UsageOverviewChart";
import { UsagePlotSkeleton } from "@/components/usage/UsagePlotPlaceholder";
import {
  UsageSegmentedControl,
  type SegmentedOption,
} from "@/components/usage/UsageSegmentedControl";
import { useUsageCharts } from "@/components/usage/use-usage-charts";
import { resolveEndDay } from "@/components/usage/usage-stats-model";
import { apiErrorMessage } from "@/lib/api-errors";
import { type SessionUsageMetric, useSessionUsageMetric } from "./session-usage-measure";

/**
 * Trailing window of the overview. Equal to the Settings "30d" range on
 * purpose: both read `{ days: 30 }`, so React Query serves one request to both.
 */
const OVERVIEW_DAYS = 30;

const NO_ENTRIES: UsageStatsEntry[] = [];

function metricOptions(t: UiTranslator) {
  return [
    {
      value: "messages",
      label: t("conversation.stream.sessionUsageChart.messages", "Messages"),
      title: t(
        "conversation.stream.sessionUsageChart.messageMeasure",
        "Prompts you sent, by the model they went to",
      ),
    },
    {
      value: "total",
      label: t("conversation.stream.sessionUsageChart.tokens", "Tokens"),
      title: t("conversation.stream.sessionUsageChart.tokenMeasure", "Input plus output tokens"),
    },
  ] as const satisfies readonly SegmentedOption<SessionUsageMetric>[];
}

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
  const { t, i18n } = useUiTranslation();
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
          {t(
            "conversation.stream.sessionUsageChart.usageIsUnavailableRightNow",
            "Usage is unavailable right now.",
          )}{" "}
          {apiErrorMessage(
            error,
            t("conversation.stream.sessionUsageChart.pleaseTryAgain", "Please try again."),
          )}
        </p>
      );
    }
    return null;
  }

  if (!summary.hasUsage) return null;

  const days = formatExactNumber(OVERVIEW_DAYS, formattingLocale(i18n.language));
  const caption =
    metric === "messages"
      ? t(
          "conversation.stream.sessionUsageChart.messagesOverDays",
          "Messages sent over the last {{days}} days",
          { days },
        )
      : t(
          "conversation.stream.sessionUsageChart.tokensOverDays",
          "Tokens exchanged over the last {{days}} days",
          { days },
        );

  return (
    <section aria-label={caption} className="w-full space-y-2">
      {error ? (
        <p role="status" className="text-[11px] text-muted-foreground">
          {t(
            "conversation.stream.sessionUsageChart.couldNotRefreshUsageShowingTheLast",
            "Could not refresh usage. Showing the last loaded data.",
          )}{" "}
          {apiErrorMessage(
            error,
            t("conversation.stream.sessionUsageChart.pleaseTryAgain", "Please try again."),
          )}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-[11px] text-muted-foreground">{caption}</p>
        <UsageSegmentedControl
          value={metric}
          options={metricOptions(t)}
          onChange={setMetric}
          ariaLabel={t("conversation.stream.sessionUsageChart.chartMeasure", "Chart measure")}
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
        emptyText={
          metric === "messages"
            ? t(
                "conversation.stream.sessionUsageChart.noMessages",
                "No messages sent in the last {{days}} days.",
                { days },
              )
            : t(
                "conversation.stream.sessionUsageChart.noTokens",
                "No tokens exchanged in the last {{days}} days.",
                { days },
              )
        }
      />
    </section>
  );
}
