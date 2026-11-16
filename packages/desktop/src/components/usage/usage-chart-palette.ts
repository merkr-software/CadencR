import { CHART_SERIES_TOKENS, OTHER_SERIES_TOKEN } from "@/lib/chart-series";
import type { UsageMetric } from "./usage-stats-model";

/** The shared series order (`lib/chart-series.ts`), as CSS colors; the tail folds to "Other". */
const SERIES_COLORS = CHART_SERIES_TOKENS.map((token) => `var(--${token})`);
const OTHER_SERIES_COLOR = `var(--${OTHER_SERIES_TOKEN})`;

export function seriesColor(colorIndex: number): string {
  return SERIES_COLORS[colorIndex] ?? OTHER_SERIES_COLOR;
}

const COMPACT = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});
/**
 * Pinned to English so the abbreviations are always K, M and B: a French locale
 * would read "1,8 Md". Two significant digits, as a chart is read at a glance;
 * the exact figure stays in titles and screen-reader labels.
 */
const CHART = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumSignificantDigits: 2,
});
const EXACT = new Intl.NumberFormat();
const DAY = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/** Counters with room for a decimal: "12.3K". */
export function formatCompactTokens(tokens: number): string {
  return COMPACT.format(tokens);
}

/** Chart, day card and tile figures: "1.8B", "320M", "1.5K". */
export function formatChartTokens(tokens: number): string {
  return CHART.format(tokens);
}

/**
 * A figure of the chart's measure. Token counts read compact; message counts
 * stay exact, as two significant digits would turn 123 prompts into "120".
 */
export function formatUsageValue(value: number, metric: UsageMetric): string {
  return metric === "messages" ? formatExactNumber(value) : formatChartTokens(value);
}

/** The precise figure, for titles and screen-reader labels: "1,801,292,560". */
export function formatExactNumber(value: number): string {
  return EXACT.format(value);
}

const SHARE = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 0,
});

/**
 * A series' part of the window total: "62%". Whole percents only — a decimal
 * implies a precision the rounded token counts do not have. A non-zero share
 * under half a percent reads "<1%" rather than a misleading "0%".
 */
export function formatShare(value: number, total: number): string {
  if (total <= 0) return SHARE.format(0);
  const share = value / total;
  if (share > 0 && share < 0.005) return "<1%";
  return SHARE.format(share);
}

/** "Jul 25" — short enough for the date labels under a chart. */
export function formatDayLabel(day: string): string {
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return day;
  return DAY.format(parsed);
}
