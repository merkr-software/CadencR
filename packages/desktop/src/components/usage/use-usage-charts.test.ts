// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ProviderCatalogResponseEntry, UsageStatsEntry } from "@/api/generated";
import { setProviderCatalogMetadata } from "@/lib/provider-catalog-registry";
import { useUsageCharts } from "./use-usage-charts";

const END_DAY = "2026-07-25";

function entry(partial: Partial<UsageStatsEntry> & { provider_id: string }): UsageStatsEntry {
  return {
    day: END_DAY,
    model_id: "opus",
    thinking_effort: "high",
    input_tokens: 10,
    output_tokens: 100,
    ...partial,
  };
}

function render(entries: UsageStatsEntry[], grouping: "provider" | "model" = "provider") {
  return renderHook(() =>
    useUsageCharts({
      entries,
      windowDays: 30,
      endDay: END_DAY,
      metric: "total",
      grouping,
    }),
  ).result.current;
}

function catalogEntry(id: string, label: string): ProviderCatalogResponseEntry {
  return { id, label, origin: "installed_local", status: "available", models: [] };
}

const acme = (label: string) => catalogEntry("acme", label);

describe("useUsageCharts", () => {
  afterEach(() => setProviderCatalogMetadata([]));

  it("renames a series when its provider is relabelled, without rebuilding the chart", () => {
    setProviderCatalogMetadata([acme("Acme")]);
    const entries = [entry({ provider_id: "acme" })];
    const { result } = renderHook(() =>
      useUsageCharts({
        entries,
        windowDays: 30,
        endDay: END_DAY,
        metric: "total",
        grouping: "provider",
      }),
    );
    expect(result.current.summary.topProvider).toBe("Acme");
    const chart = result.current.chart;

    act(() => setProviderCatalogMetadata([acme("Acme Agent")]));

    expect(result.current.labelOf("acme")).toBe("Acme Agent");
    expect(result.current.summary.topProvider).toBe("Acme Agent");
    expect(result.current.chart).toBe(chart);
  });

  it("keeps each provider's color when two providers swap ranks", () => {
    setProviderCatalogMetadata([
      catalogEntry("claude_code", "Claude"),
      catalogEntry("codex_cli", "Codex"),
    ]);
    const colorOf = (entries: UsageStatsEntry[], key: string) =>
      render(entries).chart.series.find((series) => series.key === key)!.colorIndex;
    const claudeAhead = [
      entry({ provider_id: "claude_code", output_tokens: 900 }),
      entry({ provider_id: "codex_cli", output_tokens: 10 }),
    ];
    const codexAhead = [
      entry({ provider_id: "claude_code", output_tokens: 10 }),
      entry({ provider_id: "codex_cli", output_tokens: 900 }),
    ];

    expect(colorOf(codexAhead, "claude_code")).toBe(colorOf(claudeAhead, "claude_code"));
    expect(colorOf(codexAhead, "codex_cli")).toBe(colorOf(claudeAhead, "codex_cli"));
    expect(colorOf(claudeAhead, "claude_code")).not.toBe(colorOf(claudeAhead, "codex_cli"));
  });

  it("ranks providers by total tokens for the provider chart", () => {
    const { chart, summary } = render([
      entry({ provider_id: "codex_cli", input_tokens: 1, output_tokens: 1 }),
      entry({ provider_id: "claude_code", input_tokens: 50, output_tokens: 500 }),
    ]);

    expect(chart.series.map((series) => series.key)).toEqual(["claude_code", "codex_cli"]);
    expect(summary.topProvider).toBe("Claude");
  });

  it("charts provider and model pairs when grouped by model, folding thinking levels", () => {
    const { chart, labelOf } = render(
      [
        entry({ provider_id: "claude_code", model_id: "opus", thinking_effort: "low" }),
        entry({ provider_id: "claude_code", model_id: "opus", thinking_effort: "high" }),
        entry({ provider_id: "codex_cli", model_id: "opus", thinking_effort: "high" }),
      ],
      "model",
    );

    // The same model id under two providers is two series, and the two efforts
    // of one provider/model pair are one.
    expect(chart.series.map((series) => labelOf(series.key))).toEqual([
      "Claude · opus",
      "Codex · opus",
    ]);
  });

  it("reports window totals that include providers folded into Other", () => {
    const entries = Array.from({ length: 6 }, (_, index) =>
      entry({ provider_id: `provider_${index}`, input_tokens: 1, output_tokens: 2 }),
    );

    const { chart, labelOf, summary } = render(entries);

    expect(labelOf(chart.series.at(-1)!.key)).toBe("Other (2)");
    expect(summary.totalInputTokens).toBe(6);
    expect(summary.totalOutputTokens).toBe(12);
  });

  it("keeps the tiles on providers whichever grouping is on screen", () => {
    const { summary } = render(
      [entry({ provider_id: "claude_code", model_id: "opus", output_tokens: 900 })],
      "model",
    );

    expect(summary.topProvider).toBe("Claude");
  });

  it("names the busiest provider and model pairing across every provider", () => {
    const { summary } = render([
      entry({ provider_id: "claude_code", model_id: "haiku", thinking_effort: "low" }),
      entry({
        provider_id: "codex_cli",
        model_id: "gpt-5.5",
        thinking_effort: "high",
        output_tokens: 900,
      }),
    ]);

    expect(summary.topModel).toEqual({ name: "gpt-5.5", label: "Codex · gpt-5.5" });
  });

  it("has no usage to chart when every row falls outside the window", () => {
    const { chart, summary } = render([entry({ provider_id: "claude_code", day: "2020-01-01" })]);

    expect(chart.series).toEqual([]);
    expect(summary.topModel).toBeNull();
    expect(summary.totalOutputTokens).toBe(0);
  });
});
