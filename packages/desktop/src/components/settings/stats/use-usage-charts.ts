import { useMemo } from "react";
import type { UsageStatsEntry } from "@/api/generated";
import { getProviderMetadata } from "@/lib/providers";
import { parseThinkingEffort, thinkingEffortLabel } from "@/shared/thinking-effort";
import {
  buildUsageChart,
  dayAxis,
  modelSeriesKey,
  splitModelSeriesKey,
  type UsageChartData,
  type UsageMetric,
} from "./usage-stats-model";
import type { UsageSummary } from "./UsageSummaryTiles";

export function providerLabel(providerId: string): string {
  return getProviderMetadata(providerId)?.label ?? providerId;
}

/**
 * "Opus · High" — the model and its thinking level read as one thing, which is
 * exactly the pairing the second chart exists to compare.
 */
export function modelLabel(seriesKey: string): string {
  const { modelId, thinkingEffort } = splitModelSeriesKey(seriesKey);
  const model = modelId || "Unknown model";
  const effort = parseThinkingEffort(thinkingEffort);
  return effort ? `${model} · ${thinkingEffortLabel(effort)}` : model;
}

export interface UsageCharts {
  providerChart: UsageChartData;
  modelChart: UsageChartData;
  /** Providers seen in the window, busiest first — drives the model filter. */
  providerIds: string[];
  /** The provider the model chart is actually showing. */
  activeProviderId: string | null;
  summary: UsageSummary;
}

export interface UseUsageChartsParams {
  entries: UsageStatsEntry[];
  windowDays: number;
  /** The window's last UTC day as the backend computed it. */
  endDay: string;
  metric: UsageMetric;
  /** The user's pick, or `null` to follow the busiest provider. */
  selectedProviderId: string | null;
}

/**
 * Pivots one flat `/api/usage-stats` payload into both timelines plus the
 * headline tiles.
 *
 * Split into dep-accurate memos so the cheap parts survive a filter click: the
 * provider ranking and totals depend only on the rows, and switching provider
 * leaves the provider chart alone.
 */
export function useUsageCharts({
  entries,
  windowDays,
  endDay,
  metric,
  selectedProviderId,
}: UseUsageChartsParams): UsageCharts {
  const axis = useMemo(() => dayAxis(windowDays, endDay), [windowDays, endDay]);

  const providerIds = useMemo(
    () => rankByTotalWords(entries, axis, (entry) => entry.provider_id),
    [entries, axis],
  );
  // Resolving the fallback here rather than syncing it into state keeps the
  // model chart from rendering every provider at once on the first paint.
  const activeProviderId =
    selectedProviderId !== null && providerIds.includes(selectedProviderId)
      ? selectedProviderId
      : (providerIds[0] ?? null);

  const providerChart = useMemo(
    () =>
      buildUsageChart({
        entries,
        metric,
        axis,
        seriesKeyOf: (entry) => entry.provider_id,
        labelOf: providerLabel,
      }),
    [entries, metric, axis],
  );

  const modelChart = useMemo(
    () =>
      buildUsageChart({
        entries,
        metric,
        axis,
        seriesKeyOf: (entry) =>
          activeProviderId !== null && entry.provider_id !== activeProviderId
            ? null
            : modelSeriesKey(entry.model_id, entry.thinking_effort),
        labelOf: modelLabel,
      }),
    [entries, metric, axis, activeProviderId],
  );

  // Ranked by total words, so the tile agrees with the chart order whichever
  // metric is on screen.
  const topModelKey = useMemo(
    () =>
      rankByTotalWords(entries, axis, (entry) =>
        modelSeriesKey(entry.model_id, entry.thinking_effort),
      )[0],
    [entries, axis],
  );

  const summary = useMemo<UsageSummary>(
    () => ({
      // Every in-window row lands in exactly one series — including the folded
      // "Other" — so the series totals are the window totals.
      totalInputWords: providerChart.series.reduce((total, s) => total + s.inputWords, 0),
      totalOutputWords: providerChart.series.reduce((total, s) => total + s.outputWords, 0),
      topProvider: providerChart.series[0]?.label ?? null,
      topModel: topModelKey === undefined ? null : modelLabel(topModelKey),
    }),
    [providerChart, topModelKey],
  );

  return useMemo(
    () => ({ providerChart, modelChart, providerIds, activeProviderId, summary }),
    [providerChart, modelChart, providerIds, activeProviderId, summary],
  );
}

/**
 * Keys present in the window, busiest first. Ties break on the key so the order
 * is stable, matching how `buildUsageChart` ranks its series.
 */
function rankByTotalWords(
  entries: UsageStatsEntry[],
  axis: string[],
  keyOf: (entry: UsageStatsEntry) => string,
): string[] {
  const inWindow = new Set(axis);
  const totals = new Map<string, number>();
  for (const entry of entries) {
    if (!inWindow.has(entry.day)) continue;
    const key = keyOf(entry);
    totals.set(key, (totals.get(key) ?? 0) + entry.input_words + entry.output_words);
  }
  return [...totals.entries()]
    .filter(([, words]) => words > 0)
    .sort(([keyA, a], [keyB, b]) => b - a || keyA.localeCompare(keyB))
    .map(([key]) => key);
}
