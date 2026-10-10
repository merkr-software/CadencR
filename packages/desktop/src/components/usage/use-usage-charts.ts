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
  /** Display label of the provider with the most tokens exchanged. */
  topProvider: string | null;
  /** The busiest model, and its full "provider · model" label for the tile's title. */
  topModel: { name: string; label: string } | null;
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

  const summary = useMemo<UsageSummary>(() => {
    // Series are ranked by total tokens whatever the metric, and "Other" is
    // always last, so the first series is the busiest.
    const topProvider = providerChart.series[0];
    const topModel = modelChart.series[0];
    return {
      // Every in-window row lands in exactly one series — including the folded
      // "Other" — so the series totals are the window totals.
      totalInputTokens: providerChart.series.reduce((total, s) => total + s.inputTokens, 0),
      totalOutputTokens: providerChart.series.reduce((total, s) => total + s.outputTokens, 0),
      topProvider: topProvider ? providerLabel(topProvider.key) : null,
      topModel:
        topModel === undefined || topModel.key === OTHER_SERIES_KEY
          ? null
          : { name: modelIdOf(topModel.key), label: modelLabel(topModel.key, providerLabel) },
    };
  }, [providerChart, modelChart, providerLabel]);

  return useMemo(() => ({ chart, labelOf, summary }), [chart, labelOf, summary]);
}
