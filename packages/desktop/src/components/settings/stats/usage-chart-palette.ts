/**
 * Categorical series colors, in fixed assignment order.
 *
 * Drawn only from the design system's own `--chart-*` ramp, so the charts
 * re-theme with every Cadencr theme instead of pinning hexes.
 *
 * Four slots, not five: `--chart-3` had to be dropped. Every theme restates the
 * whole ramp, so the hues below are the Cadencr brand theme's — there
 * `--chart-3` (leafy green) sits too close to both `--chart-1` (emerald) and
 * `--chart-5` (amber) to be told apart, the green/amber pair scoring a
 * normal-vision ΔE of ~12, under the 15 floor, before colorblindness enters
 * into it. Cutting the series count is the correct response to that, not
 * inventing a hue outside the system.
 *
 * The remaining order — emerald → blue → pink → amber in that theme — keeps
 * every adjacent pair above the deutan/protan floor (worst pair ΔE 10.3 dark,
 * 12.0 light).
 *
 * Ranks past the fourth series never get a generated fifth hue; they fold into
 * `OTHER_SERIES_COLOR`. See `MAX_COLORED_SERIES`.
 */
const SERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-4)",
  "var(--chart-2)",
  "var(--chart-5)",
] as const;

/** The folded tail. Deliberately colorless — it is a bucket, not an entity. */
const OTHER_SERIES_COLOR = "var(--muted-foreground)";

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
