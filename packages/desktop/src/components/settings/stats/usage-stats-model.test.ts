import { describe, expect, it } from "vitest";
import type { UsageStatsEntry } from "@/api/generated";
import {
  buildUsageChart,
  dayAxis,
  MAX_COLORED_SERIES,
  metricValue,
  modelSeriesKey,
  OTHER_SERIES_KEY,
  resolveEndDay,
  splitModelSeriesKey,
  utcToday,
} from "./usage-stats-model";

function entry(overrides: Partial<UsageStatsEntry> = {}): UsageStatsEntry {
  return {
    day: "2026-07-25",
    provider_id: "claude_code",
    model_id: "opus",
    thinking_effort: "high",
    input_words: 10,
    output_words: 90,
    ...overrides,
  };
}

const byProvider = (row: UsageStatsEntry): string => row.provider_id;
const identity = (key: string): string => key;

describe("metricValue", () => {
  it("splits the exchange into sent, received, and their sum", () => {
    const row = entry({ input_words: 3, output_words: 7 });
    expect(metricValue(row, "input")).toBe(3);
    expect(metricValue(row, "output")).toBe(7);
    expect(metricValue(row, "total")).toBe(10);
  });
});

describe("modelSeriesKey", () => {
  it("round-trips a model and its thinking level", () => {
    expect(splitModelSeriesKey(modelSeriesKey("claude-opus-5", "xhigh"))).toEqual({
      modelId: "claude-opus-5",
      thinkingEffort: "xhigh",
    });
  });

  it("keeps the same model at different efforts apart", () => {
    expect(modelSeriesKey("opus", "high")).not.toBe(modelSeriesKey("opus", "low"));
  });

  it("does not collide when a model id contains spaces or dashes", () => {
    expect(splitModelSeriesKey(modelSeriesKey("gpt 5-codex", ""))).toEqual({
      modelId: "gpt 5-codex",
      thinkingEffort: "",
    });
  });
});

describe("dayAxis", () => {
  it("returns one entry per day, oldest first, ending on the given day", () => {
    expect(dayAxis(3, "2026-07-25")).toEqual(["2026-07-23", "2026-07-24", "2026-07-25"]);
  });

  it("crosses a month boundary", () => {
    expect(dayAxis(2, "2026-08-01")).toEqual(["2026-07-31", "2026-08-01"]);
  });

  it("returns nothing for an unusable window", () => {
    expect(dayAxis(0, "2026-07-25")).toEqual([]);
    expect(dayAxis(5, "not-a-day")).toEqual([]);
  });
});

describe("utcToday", () => {
  it("reads the UTC date, not the local one", () => {
    expect(utcToday(new Date("2026-07-25T23:30:00Z"))).toBe("2026-07-25");
  });
});

describe("resolveEndDay", () => {
  it("prefers the server's day over the local clock", () => {
    // The client is a day behind the database — the server must win.
    expect(resolveEndDay("2026-07-25", new Date("2026-07-24T23:59:00Z"))).toBe("2026-07-25");
  });

  it("falls back to the client clock when the server sends nothing usable", () => {
    const now = new Date("2026-07-25T10:00:00Z");
    for (const bad of [undefined, null, "", "not-a-day", "2026-7-5"]) {
      expect(resolveEndDay(bad, now)).toBe("2026-07-25");
    }
  });
});

describe("buildUsageChart", () => {
  const axis = dayAxis(3, "2026-07-25");

  it("keeps a day with no usage on the axis", () => {
    const chart = buildUsageChart({
      entries: [entry({ day: "2026-07-25" })],
      metric: "total",
      seriesKeyOf: byProvider,
      labelOf: identity,
      axis,
    });

    expect(chart.days.map((day) => day.day)).toEqual(axis);
    expect(chart.days[0].total).toBe(0);
    expect(chart.days[0].segments).toEqual([]);
    expect(chart.days[2].total).toBe(100);
  });

  it("sums buckets that differ only by model into one provider series", () => {
    const chart = buildUsageChart({
      entries: [
        entry({ model_id: "opus", input_words: 1, output_words: 2 }),
        entry({ model_id: "sonnet", input_words: 3, output_words: 4 }),
      ],
      metric: "total",
      seriesKeyOf: byProvider,
      labelOf: identity,
      axis,
    });

    expect(chart.series).toHaveLength(1);
    expect(chart.series[0]).toMatchObject({
      key: "claude_code",
      inputWords: 4,
      outputWords: 6,
      value: 10,
    });
    expect(chart.max).toBe(10);
    expect(chart.grandTotal).toBe(10);
  });

  it("charts only the selected metric but still reports both halves", () => {
    const chart = buildUsageChart({
      entries: [entry({ input_words: 10, output_words: 90 })],
      metric: "input",
      seriesKeyOf: byProvider,
      labelOf: identity,
      axis,
    });

    expect(chart.max).toBe(10);
    expect(chart.series[0].inputWords).toBe(10);
    expect(chart.series[0].outputWords).toBe(90);
  });

  it("ranks series by total words regardless of the charted metric", () => {
    // "quiet" sends far more than it receives; "loud" is the bigger overall.
    const entries = [
      entry({ provider_id: "loud", input_words: 1, output_words: 500 }),
      entry({ provider_id: "quiet", input_words: 100, output_words: 1 }),
    ];
    const forEachMetric = (["total", "input", "output"] as const).map(
      (metric) =>
        buildUsageChart({ entries, metric, seriesKeyOf: byProvider, labelOf: identity, axis })
          .series[0].key,
    );

    expect(forEachMetric).toEqual(["loud", "loud", "loud"]);
  });

  it("assigns one palette slot per series in rank order", () => {
    const chart = buildUsageChart({
      entries: [
        entry({ provider_id: "a", input_words: 0, output_words: 5 }),
        entry({ provider_id: "b", input_words: 0, output_words: 50 }),
      ],
      metric: "total",
      seriesKeyOf: byProvider,
      labelOf: identity,
      axis,
    });

    expect(chart.series.map((series) => [series.key, series.colorIndex])).toEqual([
      ["b", 0],
      ["a", 1],
    ]);
  });

  it("folds everything past the palette into one Other bucket", () => {
    const FOLDED_COUNT = 3;
    // Descending, so p0 ranks first and the last FOLDED_COUNT entries fold.
    const wordsFor = (index: number): number => 100 - index;
    const entries = Array.from({ length: MAX_COLORED_SERIES + FOLDED_COUNT }, (_, index) =>
      entry({ provider_id: `p${index}`, input_words: 0, output_words: wordsFor(index) }),
    );
    const expectedFoldedTotal = Array.from({ length: FOLDED_COUNT }, (_, offset) =>
      wordsFor(MAX_COLORED_SERIES + offset),
    ).reduce((sum, words) => sum + words, 0);

    const chart = buildUsageChart({
      entries,
      metric: "total",
      seriesKeyOf: byProvider,
      labelOf: identity,
      axis,
    });

    expect(chart.series).toHaveLength(MAX_COLORED_SERIES + 1);
    expect(chart.series.filter((s) => s.colorIndex >= 0)).toHaveLength(MAX_COLORED_SERIES);
    const other = chart.series.at(-1)!;
    expect(other.key).toBe(OTHER_SERIES_KEY);
    expect(other.colorIndex).toBe(-1);
    expect(other.label).toBe(`Other (${FOLDED_COUNT})`);
    expect(other.value).toBe(expectedFoldedTotal);
    expect(chart.days.at(-1)!.total).toBe(chart.grandTotal);
  });

  it("excludes entries the bucketer rejects", () => {
    const chart = buildUsageChart({
      entries: [entry({ provider_id: "keep" }), entry({ provider_id: "drop" })],
      metric: "total",
      seriesKeyOf: (row) => (row.provider_id === "keep" ? row.provider_id : null),
      labelOf: identity,
      axis,
    });

    expect(chart.series.map((series) => series.key)).toEqual(["keep"]);
    expect(chart.grandTotal).toBe(100);
  });

  it("excludes entries outside the axis window", () => {
    const chart = buildUsageChart({
      entries: [entry({ day: "2026-01-01" })],
      metric: "total",
      seriesKeyOf: byProvider,
      labelOf: identity,
      axis,
    });

    expect(chart.series).toEqual([]);
    expect(chart.max).toBe(0);
    expect(chart.grandTotal).toBe(0);
  });

  it("produces an empty chart with a full axis when there is no usage", () => {
    const chart = buildUsageChart({
      entries: [],
      metric: "total",
      seriesKeyOf: byProvider,
      labelOf: identity,
      axis,
    });

    expect(chart.series).toEqual([]);
    expect(chart.days).toHaveLength(3);
    expect(chart.max).toBe(0);
  });
});
