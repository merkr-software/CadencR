import { formatExactNumber } from "@/lib/format-number";
import { formattingLocale } from "@/lib/i18n/formatting-locale";
import { useUiTranslation } from "@/lib/i18n/ui";
import { formatChartTokens, formatCompactTokens } from "@/components/usage/usage-chart-palette";
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
  const { t } = useUiTranslation();
  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      {metric === "messages" ? (
        <MessageTiles total={summary.totalUserMessages} windowDays={windowDays} />
      ) : (
        <TokenTiles summary={summary} />
      )}
      <Tile
        label={t("system.usageSummaryTiles.topProvider", "Top provider")}
        value={summary.topProvider ?? t("system.usage.none", "None")}
        name
      />
      <Tile
        label={t("system.usageSummaryTiles.topModel", "Top model")}
        value={summary.topModel?.name ?? t("system.usage.none", "None")}
        title={summary.topModel?.label}
        name
      />
    </div>
  );
}

function TokenTiles({ summary }: { summary: UsageSummary }): React.JSX.Element {
  const { t, i18n } = useUiTranslation();
  const locale = formattingLocale(i18n.language);
  return (
    <>
      <Tile
        label={t("system.usageSummaryTiles.input", "Input")}
        value={formatChartTokens(summary.totalInputTokens, locale)}
        title={t("system.usage.titleInputTokens", "{{formattedCount}} input tokens", {
          count: summary.totalInputTokens,
          formattedCount: formatExactNumber(summary.totalInputTokens, locale),
          defaultValue_zero: "{{formattedCount}} input tokens",
          defaultValue_one: "{{formattedCount}} input token",
          defaultValue_other: "{{formattedCount}} input tokens",
        })}
      />
      <Tile
        label={t("system.usageSummaryTiles.output", "Output")}
        value={formatChartTokens(summary.totalOutputTokens, locale)}
        title={t("system.usage.titleOutputTokens", "{{formattedCount}} output tokens", {
          count: summary.totalOutputTokens,
          formattedCount: formatExactNumber(summary.totalOutputTokens, locale),
          defaultValue_zero: "{{formattedCount}} output tokens",
          defaultValue_one: "{{formattedCount}} output token",
          defaultValue_other: "{{formattedCount}} output tokens",
        })}
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
  const { t, i18n } = useUiTranslation();
  const locale = formattingLocale(i18n.language);
  const perDay = formatCompactTokens(total / Math.max(1, windowDays), locale);
  return (
    <>
      <Tile
        label={t("system.usageSummaryTiles.messagesSent", "Messages sent")}
        value={formatExactNumber(total, locale)}
        title={t("system.usage.titleMessages", "{{formattedCount}} messages sent", {
          count: total,
          formattedCount: formatExactNumber(total, locale),
          defaultValue_zero: "{{formattedCount}} messages sent",
          defaultValue_one: "{{formattedCount}} message sent",
          defaultValue_other: "{{formattedCount}} messages sent",
        })}
      />
      <Tile
        label={t("system.usageSummaryTiles.dailyAverage", "Daily average")}
        value={perDay}
        title={t("system.usage.averageOverDays", "{{average}} messages a day over {{days}} days", {
          average: perDay,
          days: formatExactNumber(windowDays, locale),
        })}
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
