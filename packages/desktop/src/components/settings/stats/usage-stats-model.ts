import type { UsageStatsEntry } from "@/api/generated";

/** Which half of the exchange a chart is showing. */
export type UsageMetric = "total" | "input" | "output";

/**
 * Number of distinct colors the chart can assign — see `SERIES_COLORS` for why
 * it is four. Anything past the fourth-largest series folds into a single muted
 * "Other" bucket rather than inventing a fifth hue.
 */
export const MAX_COLORED_SERIES = 4;

export const OTHER_SERIES_KEY = "__other__";

export interface UsageSeries {
  key: string;
  label: string;
  /** Palette slot `0…MAX_COLORED_SERIES-1`, or `-1` for the "Other" bucket. */
  colorIndex: number;
  inputTokens: number;
  outputTokens: number;
  /** The metric currently being charted — what the bar heights encode. */
  value: number;
}

export interface UsageDay {
  day: string;
  /** One entry per series with a non-zero value, in series order. */
  segments: { key: string; value: number }[];
  total: number;
}

export interface UsageChartData {
  /** Ranked by total usage, largest first; "Other" (if any) always last. */
  series: UsageSeries[];
  /** Every day in the window, oldest first — including days with no usage. */
  days: UsageDay[];
  /** Largest single-day total; the y-axis top. `0` when there is no usage. */
  max: number;
  grandTotal: number;
}

export function metricValue(entry: UsageStatsEntry, metric: UsageMetric): number {
  if (metric === "input") return entry.input_tokens;
  if (metric === "output") return entry.output_tokens;
  return entry.input_tokens + entry.output_tokens;
}

/**
 * Composite key for the model chart. The user reads a model and its thinking
 * level as one thing ("Opus · High"), so they are one series, not two
 * dimensions.
 */
/** U+0000 — not producible by any model id or effort level. */
const MODEL_KEY_SEPARATOR = "\u0000";

export function modelSeriesKey(modelId: string, thinkingEffort: string): string {
  return `${modelId}${MODEL_KEY_SEPARATOR}${thinkingEffort}`;
}

export function splitModelSeriesKey(key: string): { modelId: string; thinkingEffort: string } {
  const [modelId = "", thinkingEffort = ""] = key.split(MODEL_KEY_SEPARATOR);
  return { modelId, thinkingEffort };
}

/**
 * Fallback end-of-window day, used only if the backend response predates the
 * authoritative `end_day` field.
 *
 * Prefer the server's value: it comes from the same database that stamped the
 * `day` column and bounded the query, so it cannot drift. Deriving the day from
 * the client clock can shift the axis off the returned rows when a request
 * straddles UTC midnight or the machine's clock is skewed — dropping the oldest
 * day and appending a blank one.
 */
export function utcToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD`, the shape both the backend and `dayAxis` speak. */
export function isDayString(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** The window's last day: the server's answer when usable, else this clock. */
export function resolveEndDay(
  serverEndDay: string | null | undefined,
  now: Date = new Date(),
): string {
  return isDayString(serverEndDay) ? serverEndDay : utcToday(now);
}

/**
 * The complete day axis, oldest first. Built from the calendar rather than from
 * the returned rows so a quiet day renders as a gap instead of silently
 * collapsing the timeline and overstating how continuous usage was.
 */
export function dayAxis(days: number, endDay: string): string[] {
  const end = Date.parse(`${endDay}T00:00:00Z`);
  if (Number.isNaN(end) || days < 1) return [];
  const axis: string[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    axis.push(new Date(end - offset * 86_400_000).toISOString().slice(0, 10));
  }
  return axis;
}

/**
 * Keys that saw usage, busiest first. Ranking is on *total* tokens whatever
 * metric is on screen, and ties break on the key so the order is stable.
 *
 * Shared so the chart's series order and the provider filter's order cannot
 * drift apart: they are the same list, ranked once.
 */
export function rankKeysByTotalTokens(totalTokensByKey: Map<string, number>): string[] {
  return [...totalTokensByKey.entries()]
    .filter(([, tokens]) => tokens > 0)
    .sort(([keyA, a], [keyB, b]) => b - a || keyA.localeCompare(keyB))
    .map(([key]) => key);
}

interface BuildUsageChartParams {
  entries: UsageStatsEntry[];
  metric: UsageMetric;
  /** Bucket an entry into a series, or `null` to exclude it entirely. */
  seriesKeyOf: (entry: UsageStatsEntry) => string | null;
  labelOf: (key: string) => string;
  /** Day axis; usually `dayAxis(windowDays, utcToday())`. */
  axis: string[];
}

interface SeriesTotals {
  inputTokens: number;
  outputTokens: number;
  value: number;
}

/**
 * Pivot flat per-day buckets into a stacked-bar timeline.
 *
 * Series are ranked — and therefore colored — by *total* tokens exchanged, never
 * by the metric currently on screen. Toggling Input / Output / Total changes
 * the bar heights, not who owns which hue, so the eye can follow one provider
 * across all three views.
 */
export function buildUsageChart({
  entries,
  metric,
  seriesKeyOf,
  labelOf,
  axis,
}: BuildUsageChartParams): UsageChartData {
  const inWindow = new Set(axis);
  const totals = new Map<string, SeriesTotals>();
  const perDay = new Map<string, Map<string, number>>();

  for (const entry of entries) {
    const key = seriesKeyOf(entry);
    if (key === null || !inWindow.has(entry.day)) continue;

    const running = totals.get(key) ?? { inputTokens: 0, outputTokens: 0, value: 0 };
    running.inputTokens += entry.input_tokens;
    running.outputTokens += entry.output_tokens;
    running.value += metricValue(entry, metric);
    totals.set(key, running);

    const day = perDay.get(entry.day) ?? new Map<string, number>();
    day.set(key, (day.get(key) ?? 0) + metricValue(entry, metric));
    perDay.set(entry.day, day);
  }

  const ranking = rankKeysByTotalTokens(
    new Map(
      [...totals].map(
        ([key, running]) => [key, running.inputTokens + running.outputTokens] as const,
      ),
    ),
  );
  const ranked = ranking.map((key) => [key, totals.get(key)!] as const);

  const colored = ranked.slice(0, MAX_COLORED_SERIES);
  const folded = ranked.slice(MAX_COLORED_SERIES);
  const foldedKeys = new Set(folded.map(([key]) => key));

  const series: UsageSeries[] = colored.map(([key, running], index) => ({
    key,
    label: labelOf(key),
    colorIndex: index,
    ...running,
  }));
  if (folded.length > 0) {
    series.push({
      key: OTHER_SERIES_KEY,
      label: `Other (${folded.length})`,
      colorIndex: -1,
      inputTokens: folded.reduce((sum, [, running]) => sum + running.inputTokens, 0),
      outputTokens: folded.reduce((sum, [, running]) => sum + running.outputTokens, 0),
      value: folded.reduce((sum, [, running]) => sum + running.value, 0),
    });
  }

  const days: UsageDay[] = axis.map((day) => {
    const raw = perDay.get(day);
    const segments: { key: string; value: number }[] = [];
    let total = 0;
    for (const entry of series) {
      const value =
        entry.key === OTHER_SERIES_KEY ? sumKeys(raw, foldedKeys) : (raw?.get(entry.key) ?? 0);
      if (value > 0) segments.push({ key: entry.key, value });
      total += value;
    }
    return { day, segments, total };
  });

  return {
    series,
    days,
    max: days.reduce((peak, day) => Math.max(peak, day.total), 0),
    grandTotal: series.reduce((sum, entry) => sum + entry.value, 0),
  };
}

function sumKeys(raw: Map<string, number> | undefined, keys: Set<string>): number {
  if (!raw) return 0;
  let total = 0;
  for (const key of keys) total += raw.get(key) ?? 0;
  return total;
}
