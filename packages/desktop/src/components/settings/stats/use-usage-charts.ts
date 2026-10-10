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
  OTHER_SERIES_KEY,
  providerModelSeriesKey,
  splitProviderModelSeriesKey,
  type UsageChartData,
  type UsageGrouping,
  type UsageMetric,
} from "./usage-stats-model";
import type { UsageSummary } from "./UsageSummaryTiles";

/**
 * Resolves a provider id to its display label. A new function whenever the
 * provider catalog changes: the catalog can land after the usage does, and the
 * charts that bake labels in must re-derive them then.
 */
function useProviderLabelOf(): (providerId: string) => string {
  const catalog = useSyncExternalStore(subscribeProviderCatalogChanges, getProviderCatalog);
  return useMemo(
    () => (providerId: string) =>
      getProviderMetadata(providerId, null, "color", catalog.get(providerId) ?? null)?.label ??
      providerId,
    [catalog],
  );
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

export interface UseUsageChartsParams {
  entries: UsageStatsEntry[];
  windowDays: number;
  /** The window's last UTC day as the backend computed it. */
  endDay: string;
  metric: UsageMetric;
  grouping: UsageGrouping;
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
}: UseUsageChartsParams): { chart: UsageChartData; summary: UsageSummary } {
  const axis = useMemo(() => dayAxis(windowDays, endDay), [windowDays, endDay]);
  const providerLabel = useProviderLabelOf();

  const providerChart = useMemo(
    () =>
      buildUsageChart({
        entries,
        metric,
        axis,
        seriesKeyOf: (entry) => entry.provider_id,
        labelOf: providerLabel,
      }),
    [entries, metric, axis, providerLabel],
  );

  const modelChart = useMemo(
    () =>
      buildUsageChart({
        entries,
        metric,
        axis,
        seriesKeyOf: modelSeriesKeyOf,
        labelOf: (key) => `${providerLabel(providerOfModelSeriesKey(key))} · ${modelIdOf(key)}`,
        // A provider's top model takes the provider's own color.
        slotKeyOf: providerOfModelSeriesKey,
      }),
    [entries, metric, axis, providerLabel],
  );

  const summary = useMemo<UsageSummary>(() => {
    // Series are ranked by total tokens whatever the metric, and "Other" is
    // always last, so the first series is the busiest model.
    const topModel = modelChart.series[0];
    return {
      // Every in-window row lands in exactly one series — including the folded
      // "Other" — so the series totals are the window totals.
      totalInputTokens: providerChart.series.reduce((total, s) => total + s.inputTokens, 0),
      totalOutputTokens: providerChart.series.reduce((total, s) => total + s.outputTokens, 0),
      topProvider: providerChart.series[0]?.label ?? null,
      topModel:
        topModel === undefined || topModel.key === OTHER_SERIES_KEY
          ? null
          : { name: modelIdOf(topModel.key), label: topModel.label },
    };
  }, [providerChart, modelChart]);

  return { chart: grouping === "provider" ? providerChart : modelChart, summary };
}
