import type { UsageStatsEntry } from "@/api/generated";

/** Which half of the exchange a chart is showing. */
export type UsageMetric = "total" | "input" | "output";

/** What a series is: the provider, or the provider and model pair. */
export type UsageGrouping = "provider" | "model";

/**
 * What a column's height encodes: the day's tokens against the window's busiest
 * day, or the day's mix alone, with every day filled to the same height.
 */
export type UsageScale = "absolute" | "share";

/** What each metric counts, as a phrase for labels: "1,234 tokens exchanged". */
export const USAGE_METRIC_UNIT: Record<UsageMetric, string> = {
  total: "tokens exchanged",
  input: "input tokens",
  output: "output tokens",
};

/**
 * Number of distinct colors the chart can assign — see `SERIES_COLORS` for why
 * it is four. Anything past the fourth-largest series folds into a single muted
 * "Other" bucket rather than inventing a fifth hue.
 */
export const MAX_COLORED_SERIES = 4;

export const OTHER_SERIES_KEY = "__other__";

/** A series is numbers only: callers name it, so labels follow the live provider catalog. */
export interface UsageSeries {
  key: string;
  /** Palette slot `0…MAX_COLORED_SERIES-1`, or `-1` for the "Other" bucket. */
  colorIndex: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageSegment {
  key: string;
  /** The series' palette slot, as in `UsageSeries.colorIndex`. */
  colorIndex: number;
  value: number;
}

export interface UsageDay {
  day: string;
  /** One entry per series with a non-zero value, in series order. */
  segments: UsageSegment[];
  total: number;
}

export interface UsageChartData {
  /** Ranked by total usage, largest first; "Other" (if any) always last. */
  series: UsageSeries[];
  /** Every day in the window, oldest first — including days with no usage. */
  days: UsageDay[];
  /** Largest single-day total, which fills a column. `0` when there is no usage. */
  max: number;
  /** How many series the "Other" bucket stands for; `0` when nothing folds. */
  foldedCount: number;
}

export function metricValue(entry: UsageStatsEntry, metric: UsageMetric): number {
  if (metric === "input") return entry.input_tokens;
  if (metric === "output") return entry.output_tokens;
  return entry.input_tokens + entry.output_tokens;
}

/** U+0000 — not producible by any provider or model id. */
const KEY_SEPARATOR = "\u0000";

/**
 * Composite key for a provider + model. Thinking level is deliberately not part
 * of it: the overview answers "which model did I use", and the per-effort split
 * is too fine a cut for a series chart.
 */
export function providerModelSeriesKey(providerId: string, modelId: string): string {
  return `${providerId}${KEY_SEPARATOR}${modelId}`;
}

export function splitProviderModelSeriesKey(key: string): { providerId: string; modelId: string } {
  const [providerId = "", modelId = ""] = key.split(KEY_SEPARATOR);
  return { providerId, modelId };
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
 */
function rankKeysByTotalTokens(totalTokensByKey: Map<string, number>): string[] {
  return [...totalTokensByKey.entries()]
    .filter(([, tokens]) => tokens > 0)
    .sort(([keyA, a], [keyB, b]) => b - a || keyA.localeCompare(keyB))
    .map(([key]) => key);
}

/**
 * The slot a key prefers, derived from the key alone (32-bit FNV-1a): the
 * fallback when the caller knows no better order. Two keys can share a slot,
 * and then the higher-ranked one wins it, so prefer a stable order when one
 * exists.
 */
export function preferredSeriesSlot(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % MAX_COLORED_SERIES;
}

/**
 * One distinct slot per colored series, in rank order. A series keeps its
 * preferred slot unless a higher-ranked series already holds it; then it takes
 * the lowest free slot. Two series never share a hue.
 *
 * This is what makes color follow the entity rather than its rank: as long as
 * preferences do not collide, switching the range or a series dropping out does
 * not repaint the survivors.
 */
function assignSeriesSlots(
  rankedKeys: string[],
  preferredSlotOf: (key: string) => number,
): number[] {
  const taken = new Set<number>();
  return rankedKeys.map((key) => {
    let slot = preferredSlotOf(key);
    if (taken.has(slot)) {
      slot = 0;
      while (taken.has(slot)) slot += 1;
    }
    taken.add(slot);
    return slot;
  });
}

interface BuildUsageChartParams {
  entries: UsageStatsEntry[];
  metric: UsageMetric;
  seriesKeyOf: (entry: UsageStatsEntry) => string;
  /**
   * The palette slot a series prefers, `0…MAX_COLORED_SERIES-1`. Defaults to a
   * hash of its key.
   */
  preferredSlotOf?: (key: string) => number;
  /** Every day of the window, from `dayAxis`. */
  axis: string[];
}

interface SeriesTotals {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Pivot flat per-day buckets into a stacked timeline.
 *
 * Series are ranked by *total* tokens exchanged, never by the metric on screen,
 * so the order of the day card is stable across Input / Output / Total. Colors
 * come from `assignSeriesSlots`, keyed by entity, so they are stable too.
 */
export function buildUsageChart({
  entries,
  metric,
  seriesKeyOf,
  preferredSlotOf = preferredSeriesSlot,
  axis,
}: BuildUsageChartParams): UsageChartData {
  const inWindow = new Set(axis);
  const totals = new Map<string, SeriesTotals>();
  const perDay = new Map<string, Map<string, number>>();

  for (const entry of entries) {
    if (!inWindow.has(entry.day)) continue;
    const key = seriesKeyOf(entry);

    const running = totals.get(key) ?? { inputTokens: 0, outputTokens: 0 };
    running.inputTokens += entry.input_tokens;
    running.outputTokens += entry.output_tokens;
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
  const slots = assignSeriesSlots(
    colored.map(([key]) => key),
    preferredSlotOf,
  );

  const series: UsageSeries[] = colored.map(([key, running], index) => ({
    key,
    colorIndex: slots[index]!,
    ...running,
  }));
  if (folded.length > 0) {
    series.push({
      key: OTHER_SERIES_KEY,
      colorIndex: -1,
      inputTokens: folded.reduce((sum, [, running]) => sum + running.inputTokens, 0),
      outputTokens: folded.reduce((sum, [, running]) => sum + running.outputTokens, 0),
    });
  }

  const days: UsageDay[] = axis.map((day) => {
    const raw = perDay.get(day);
    const segments: UsageSegment[] = [];
    let total = 0;
    for (const entry of series) {
      const value =
        entry.key === OTHER_SERIES_KEY ? sumKeys(raw, foldedKeys) : (raw?.get(entry.key) ?? 0);
      if (value > 0) segments.push({ key: entry.key, colorIndex: entry.colorIndex, value });
      total += value;
    }
    return { day, segments, total };
  });

  return {
    series,
    days,
    max: days.reduce((peak, day) => Math.max(peak, day.total), 0),
    foldedCount: folded.length,
  };
}

function sumKeys(raw: Map<string, number> | undefined, keys: Set<string>): number {
  if (!raw) return 0;
  let total = 0;
  for (const key of keys) total += raw.get(key) ?? 0;
  return total;
}
