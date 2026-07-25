import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import type { UsageStatsEntry } from "@/api/generated";
import { useUsageCharts } from "./use-usage-charts";

const END_DAY = "2026-07-25";

function entry(partial: Partial<UsageStatsEntry> & { provider_id: string }): UsageStatsEntry {
  return {
    day: END_DAY,
    model_id: "opus",
    thinking_effort: "high",
    input_words: 10,
    output_words: 100,
    ...partial,
  };
}

function render(entries: UsageStatsEntry[], selectedProviderId: string | null = null) {
  return renderHook(() =>
    useUsageCharts({
      entries,
      windowDays: 30,
      endDay: END_DAY,
      metric: "total",
      selectedProviderId,
    }),
  ).result.current;
}

describe("useUsageCharts", () => {
  it("ranks providers by total words and follows the busiest one by default", () => {
    const charts = render([
      entry({ provider_id: "codex_cli", input_words: 1, output_words: 1 }),
      entry({ provider_id: "claude_code", input_words: 50, output_words: 500 }),
    ]);

    expect(charts.providerIds).toEqual(["claude_code", "codex_cli"]);
    // Derived, not synced into state: the model chart must never render every
    // provider at once while an effect catches up.
    expect(charts.activeProviderId).toBe("claude_code");
    expect(charts.summary.topProvider).toBe("Claude");
  });

  it("keeps the user's pick while it still has usage", () => {
    const entries = [
      entry({ provider_id: "claude_code", input_words: 50, output_words: 500 }),
      entry({ provider_id: "codex_cli" }),
    ];

    expect(render(entries, "codex_cli").activeProviderId).toBe("codex_cli");
  });

  it("falls back to the busiest provider when the pick has no usage in range", () => {
    const charts = render([entry({ provider_id: "claude_code" })], "cursor_agent");

    expect(charts.activeProviderId).toBe("claude_code");
  });

  it("reports window totals that include providers folded into Other", () => {
    const entries = Array.from({ length: 6 }, (_, index) =>
      entry({ provider_id: `provider_${index}`, input_words: 1, output_words: 2 }),
    );

    const { summary } = render(entries);

    expect(summary.totalInputWords).toBe(6);
    expect(summary.totalOutputWords).toBe(12);
  });

  it("names the busiest model and effort pairing across every provider", () => {
    const charts = render([
      entry({ provider_id: "claude_code", model_id: "haiku", thinking_effort: "low" }),
      entry({
        provider_id: "codex_cli",
        model_id: "gpt-5.5",
        thinking_effort: "high",
        output_words: 900,
      }),
    ]);

    expect(charts.summary.topModel).toBe("gpt-5.5 · High");
  });

  it("has no usage to chart when every row falls outside the window", () => {
    const charts = render([entry({ provider_id: "claude_code", day: "2020-01-01" })]);

    expect(charts.providerIds).toEqual([]);
    expect(charts.activeProviderId).toBeNull();
    expect(charts.summary.topModel).toBeNull();
    expect(charts.summary.totalOutputWords).toBe(0);
  });
});
