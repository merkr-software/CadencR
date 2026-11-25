import { formatExactNumber, formatPercent } from "@/lib/format-number";
import { formattingLocale } from "@/lib/i18n/formatting-locale";
import { CHART_SERIES_TOKENS, OTHER_SERIES_TOKEN } from "@/lib/chart-series";
import type { UsageMetric } from "./usage-stats-model";

/** The shared series order (`lib/chart-series.ts`), as CSS colors; the tail folds to "Other". */
const SERIES_COLORS = CHART_SERIES_TOKENS.map((token) => `var(--${token})`);
const OTHER_SERIES_COLOR = `var(--${OTHER_SERIES_TOKEN})`;

export function seriesColor(colorIndex: number): string {
  return SERIES_COLORS[colorIndex] ?? OTHER_SERIES_COLOR;
}

const formatters = new Map<string, ReturnType<typeof createFormatters>>();

function createFormatters(locale: string) {
  return {
    compact: new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }),
    chart: new Intl.NumberFormat(locale, { notation: "compact", maximumSignificantDigits: 2 }),
    day: new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" }),
  };
}

function getFormatters(locale: string) {
  const existing = formatters.get(locale);
  if (existing) return existing;
  const created = createFormatters(locale);
  formatters.set(locale, created);
  return created;
}

/** Counters with room for a decimal: "12.3K". */
export function formatCompactTokens(tokens: number, locale = formattingLocale("")): string {
  return getFormatters(locale).compact.format(tokens);
}

/** Chart, day card and tile figures: "1.8B", "320M", "1.5K". */
export function formatChartTokens(tokens: number, locale = "en"): string {
  return getFormatters(locale).chart.format(tokens);
}

/**
 * Message counts stay exact, as two significant digits would turn 123 prompts into "120".
 */
export function formatUsageValue(value: number, metric: UsageMetric, locale: string): string {
  return metric === "messages"
    ? formatExactNumber(value, locale)
    : formatChartTokens(value, locale);
}

/** A non-zero share below half a percent reads "<1%" rather than "0%". */
export function formatShare(value: number, total: number, locale = "en"): string {
  const share = total > 0 ? value / total : 0;
  if (share > 0 && share < 0.005) return `<${formatPercent(0.01, locale)}`;
  return formatPercent(share, locale);
}

export function formatDayLabel(day: string, locale = "en"): string {
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return day;
  return getFormatters(locale).day.format(parsed);
}
