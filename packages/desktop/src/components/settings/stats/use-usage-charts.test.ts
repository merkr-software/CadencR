import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { UsageStatsEntry } from "@/api/generated";
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

describe("useUsageCharts", () => {
  afterEach(() => setProviderCatalogMetadata([]));

  it("relabels the series when the provider catalog lands after the usage", () => {
    const { result } = renderHook(() =>
      useUsageCharts({
        entries: [entry({ provider_id: "acme" })],
        windowDays: 30,
        endDay: END_DAY,
        metric: "total",
        grouping: "provider",
      }),
    );
    expect(result.current.summary.topProvider).toBe("Acme");

    act(() =>
      setProviderCatalogMetadata([
        {
          id: "acme",
          label: "Acme Agent",
          origin: "installed_local",
          status: "available",
          models: [],
        },
      ]),
    );

    expect(result.current.chart.series[0]?.label).toBe("Acme Agent");
    expect(result.current.summary.topProvider).toBe("Acme Agent");
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
    const { chart } = render(
      [
        entry({ provider_id: "claude_code", model_id: "opus", thinking_effort: "low" }),
        entry({ provider_id: "claude_code", model_id: "opus", thinking_effort: "high" }),
        entry({ provider_id: "codex_cli", model_id: "opus", thinking_effort: "high" }),
      ],
      "model",
    );

    // The same model id under two providers is two series, and the two efforts
    // of one provider/model pair are one.
    expect(chart.series.map((series) => series.label)).toEqual(["Claude · opus", "Codex · opus"]);
  });

  it("reports window totals that include providers folded into Other", () => {
    const entries = Array.from({ length: 6 }, (_, index) =>
      entry({ provider_id: `provider_${index}`, input_tokens: 1, output_tokens: 2 }),
    );

    const { summary } = render(entries);

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
