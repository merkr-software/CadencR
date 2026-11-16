import { useMemo, useSyncExternalStore } from "react";
import type { UsageStatsEntry } from "@/api/generated";
import {
  getProviderCatalog,
  subscribeProviderCatalogChanges,
} from "@/lib/provider-catalog-registry";
import { getProviderMetadata } from "@/lib/providers";
import {
  buildUsageChart,
  dayAxis,
  MAX_COLORED_SERIES,
  OTHER_SERIES_KEY,
  preferredSeriesSlot,
  providerModelSeriesKey,
  splitProviderModelSeriesKey,
  type UsageChartData,
  type UsageGrouping,
  type UsageMetric,
} from "./usage-stats-model";

/** Joins provider ids into one comparable string; no provider id contains it. */
const KEY_LIST_SEPARATOR = "\u0000";

interface ProviderLookups {
  labelOf: (providerId: string) => string;
  /**
   * A provider's palette slot: its place in the catalog, which is registration
   * order and so the same in every chart and range. A hash of the key alone
   * would let two providers collide, and the busier one would take the hue,
   * repainting both whenever their ranks swap.
   */
  slotOf: (providerId: string) => number;
}

/**
 * Read from the live provider catalog, which can land after the usage does.
 * `slotOf` changes only with the catalog's order, so a relabelled provider
 * renames its series without rebuilding the charts.
 */
function useProviderLookups(): ProviderLookups {
  const catalog = useSyncExternalStore(subscribeProviderCatalogChanges, getProviderCatalog);
  const order = [...catalog.keys()].join(KEY_LIST_SEPARATOR);
  const slotOf = useMemo(() => {
    const positions = new Map(order.split(KEY_LIST_SEPARATOR).map((id, index) => [id, index]));
    return (providerId: string) => {
      const position = positions.get(providerId);
      return position === undefined
        ? preferredSeriesSlot(providerId)
        : position % MAX_COLORED_SERIES;
    };
  }, [order]);
  const labelOf = useMemo(
    () => (providerId: string) =>
      getProviderMetadata(providerId, null, "color", catalog.get(providerId) ?? null)?.label ??
      providerId,
    [catalog],
  );
  return { labelOf, slotOf };
}

function modelIdOf(seriesKey: string): string {
  return splitProviderModelSeriesKey(seriesKey).modelId || "Unknown model";
}

function providerOfModelSeriesKey(seriesKey: string): string {
  return splitProviderModelSeriesKey(seriesKey).providerId;
}

function modelSeriesKeyOf(entry: UsageStatsEntry): string {
  return providerModelSeriesKey(entry.provider_id, entry.model_id);
}

/** "Claude · claude-opus-4-8" — a series of the model chart. */
function modelLabel(seriesKey: string, providerLabel: (providerId: string) => string): string {
  return `${providerLabel(providerOfModelSeriesKey(seriesKey))} · ${modelIdOf(seriesKey)}`;
}

export interface UsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalUserMessages: number;
  /** Whether the window holds any tokens or messages at all. */
  hasUsage: boolean;
  /**
   * Display label of the busiest provider: most messages sent when the measure
   * is messages, most tokens exchanged otherwise.
   */
  topProvider: string | null;
  /** The busiest model, and its full "provider · model" label for the tile's title. */
  topModel: { name: string; label: string } | null;
}

/**
 * Summed from the rows rather than the series: a chart drops the series with
 * nothing to show for its measure, such as a model that was sent messages but
 * has not reported tokens yet.
 */
function windowTotals(
  entries: UsageStatsEntry[],
  axis: string[],
): Pick<UsageSummary, "totalInputTokens" | "totalOutputTokens" | "totalUserMessages" | "hasUsage"> {
  const inWindow = new Set(axis);
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalUserMessages = 0;
  for (const entry of entries) {
    if (!inWindow.has(entry.day)) continue;
    totalInputTokens += entry.input_tokens;
    totalOutputTokens += entry.output_tokens;
    totalUserMessages += entry.user_messages;
  }
  return {
    totalInputTokens,
    totalOutputTokens,
    totalUserMessages,
    hasUsage: totalInputTokens + totalOutputTokens + totalUserMessages > 0,
  };
}

export interface UseUsageChartsParams {
  entries: UsageStatsEntry[];
  windowDays: number;
  /** The window's last UTC day as the backend computed it. */
  endDay: string;
  metric: UsageMetric;
  grouping: UsageGrouping;
}

export interface UsageCharts {
  /** The chart for the grouping asked for. */
  chart: UsageChartData;
  /** Names a series of `chart`. */
  labelOf: (seriesKey: string) => string;
  summary: UsageSummary;
}

/**
 * Pivots one flat `/api/usage-stats` payload into the chart and the headline
 * tiles. The tiles always read providers and models, whichever grouping is on
 * screen, so "Top provider" never depends on a display choice.
 *
 * Both groupings are built: the model chart also names the top model, and a
 * window holds at most a few hundred rows.
 */
export function useUsageCharts({
  entries,
  windowDays,
  endDay,
  metric,
  grouping,
}: UseUsageChartsParams): UsageCharts {
  const axis = useMemo(() => dayAxis(windowDays, endDay), [windowDays, endDay]);
  const { labelOf: providerLabel, slotOf: providerSlot } = useProviderLookups();

  const providerChart = useMemo(
    () =>
      buildUsageChart({
        entries,
        metric,
        axis,
        seriesKeyOf: (entry) => entry.provider_id,
        preferredSlotOf: providerSlot,
      }),
    [entries, metric, axis, providerSlot],
  );
  const modelChart = useMemo(
    () =>
      buildUsageChart({
        entries,
        metric,
        axis,
        seriesKeyOf: modelSeriesKeyOf,
        // A provider's top model takes the provider's own color.
        preferredSlotOf: (key) => providerSlot(providerOfModelSeriesKey(key)),
      }),
    [entries, metric, axis, providerSlot],
  );
  const chart = grouping === "provider" ? providerChart : modelChart;

  const labelOf = useMemo(() => {
    const { foldedCount } = chart;
    return (seriesKey: string) => {
      if (seriesKey === OTHER_SERIES_KEY) return `Other (${foldedCount})`;
      return grouping === "provider"
        ? providerLabel(seriesKey)
        : modelLabel(seriesKey, providerLabel);
    };
  }, [chart, grouping, providerLabel]);

  // Independent of the measure, so toggling it does not re-sum the window.
  const totals = useMemo(() => windowTotals(entries, axis), [entries, axis]);
  const summary = useMemo<UsageSummary>(() => {
    // Series are ranked on the measure's family — messages, or total tokens
    // for every token metric — and "Other" is always last, so the first series
    // is the busiest.
    const topProvider = providerChart.series[0];
    const topModel = modelChart.series[0];
    return {
      ...totals,
      topProvider: topProvider ? providerLabel(topProvider.key) : null,
      topModel:
        topModel === undefined || topModel.key === OTHER_SERIES_KEY
          ? null
          : { name: modelIdOf(topModel.key), label: modelLabel(topModel.key, providerLabel) },
    };
  }, [totals, providerChart, modelChart, providerLabel]);

  return useMemo(() => ({ chart, labelOf, summary }), [chart, labelOf, summary]);
}
