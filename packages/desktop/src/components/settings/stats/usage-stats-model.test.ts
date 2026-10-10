import { describe, expect, it } from "vitest";
import type { UsageStatsEntry } from "@/api/generated";
import {
  buildUsageChart,
  dayAxis,
  MAX_COLORED_SERIES,
  metricValue,
  OTHER_SERIES_KEY,
  preferredSeriesSlot,
  providerModelSeriesKey,
  resolveEndDay,
  splitProviderModelSeriesKey,
  utcToday,
} from "./usage-stats-model";

function entry(overrides: Partial<UsageStatsEntry> = {}): UsageStatsEntry {
  return {
    day: "2026-07-25",
    provider_id: "claude_code",
    model_id: "opus",
    thinking_effort: "high",
    input_tokens: 10,
    output_tokens: 90,
    ...overrides,
  };
}

const byProvider = (row: UsageStatsEntry): string => row.provider_id;
const identity = (key: string): string => key;

describe("metricValue", () => {
  it("splits the exchange into sent, received, and their sum", () => {
    const row = entry({ input_tokens: 3, output_tokens: 7 });
    expect(metricValue(row, "input")).toBe(3);
    expect(metricValue(row, "output")).toBe(7);
    expect(metricValue(row, "total")).toBe(10);
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
        entry({ model_id: "opus", input_tokens: 1, output_tokens: 2 }),
        entry({ model_id: "sonnet", input_tokens: 3, output_tokens: 4 }),
      ],
      metric: "total",
      seriesKeyOf: byProvider,
      labelOf: identity,
      axis,
    });

    expect(chart.series).toHaveLength(1);
    expect(chart.series[0]).toMatchObject({
      key: "claude_code",
      inputTokens: 4,
      outputTokens: 6,
      value: 10,
    });
    expect(chart.max).toBe(10);
    expect(chart.grandTotal).toBe(10);
  });

  it("charts only the selected metric but still reports both halves", () => {
    const chart = buildUsageChart({
      entries: [entry({ input_tokens: 10, output_tokens: 90 })],
      metric: "input",
      seriesKeyOf: byProvider,
      labelOf: identity,
      axis,
    });

    expect(chart.max).toBe(10);
    expect(chart.series[0].inputTokens).toBe(10);
    expect(chart.series[0].outputTokens).toBe(90);
  });

  it("ranks series by total tokens regardless of the charted metric", () => {
    // "quiet" sends far more than it receives; "loud" is the bigger overall.
    const entries = [
      entry({ provider_id: "loud", input_tokens: 1, output_tokens: 500 }),
      entry({ provider_id: "quiet", input_tokens: 100, output_tokens: 1 }),
    ];
    const forEachMetric = (["total", "input", "output"] as const).map(
      (metric) =>
        buildUsageChart({ entries, metric, seriesKeyOf: byProvider, labelOf: identity, axis })
          .series[0].key,
    );

    expect(forEachMetric).toEqual(["loud", "loud", "loud"]);
  });

  it("gives every colored series its own slot, even when their preferred slots collide", () => {
    const first = "k0";
    const collider = Array.from({ length: 64 }, (_, index) => `k${index + 1}`).find(
      (key) => preferredSeriesSlot(key) === preferredSeriesSlot(first),
    )!;
    const chart = buildUsageChart({
      entries: [
        entry({ provider_id: first, input_tokens: 0, output_tokens: 50 }),
        entry({ provider_id: collider, input_tokens: 0, output_tokens: 5 }),
      ],
      metric: "total",
      seriesKeyOf: byProvider,
      labelOf: identity,
      axis,
    });

    const slots = chart.series.map((series) => series.colorIndex);
    expect(new Set(slots).size).toBe(slots.length);
  });

  it("keeps a series' color when other series come and go", () => {
    const anchor = "anchor";
    const other = ["b", "c", "d", "e", "f", "g"].find(
      (key) => preferredSeriesSlot(key) !== preferredSeriesSlot(anchor),
    )!;
    const colorOf = (entries: UsageStatsEntry[], key: string) =>
      buildUsageChart({
        entries,
        metric: "total",
        seriesKeyOf: byProvider,
        labelOf: identity,
        axis,
      }).series.find((series) => series.key === key)!.colorIndex;

    const alone = colorOf([entry({ provider_id: anchor })], anchor);
    // The newcomer ranks above the anchor, so the anchor is no longer first.
    const crowded = colorOf(
      [entry({ provider_id: other, output_tokens: 900 }), entry({ provider_id: anchor })],
      anchor,
    );

    expect(crowded).toBe(alone);
  });

  it("lets a series prefer its parent's hue, while siblings stay apart", () => {
    const chart = buildUsageChart({
      entries: [
        entry({ provider_id: "x", model_id: "big", output_tokens: 900 }),
        entry({ provider_id: "x", model_id: "small", output_tokens: 10 }),
      ],
      metric: "total",
      seriesKeyOf: (row) => `${row.provider_id}/${row.model_id}`,
      labelOf: identity,
      slotKeyOf: (key) => key.split("/")[0]!,
      axis,
    });

    expect(chart.series[0]!.colorIndex).toBe(preferredSeriesSlot("x"));
    expect(chart.series[1]!.colorIndex).not.toBe(chart.series[0]!.colorIndex);
  });

  it("folds everything past the palette into one Other bucket", () => {
    const FOLDED_COUNT = 3;
    // Descending, so p0 ranks first and the last FOLDED_COUNT entries fold.
    const tokensFor = (index: number): number => 100 - index;
    const entries = Array.from({ length: MAX_COLORED_SERIES + FOLDED_COUNT }, (_, index) =>
      entry({ provider_id: `p${index}`, input_tokens: 0, output_tokens: tokensFor(index) }),
    );
    const expectedFoldedTotal = Array.from({ length: FOLDED_COUNT }, (_, offset) =>
      tokensFor(MAX_COLORED_SERIES + offset),
    ).reduce((sum, tokens) => sum + tokens, 0);

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

describe("providerModelSeriesKey", () => {
  it("round-trips a provider and its model", () => {
    expect(splitProviderModelSeriesKey(providerModelSeriesKey("codex_cli", "gpt 5-codex"))).toEqual(
      {
        providerId: "codex_cli",
        modelId: "gpt 5-codex",
      },
    );
  });

  it("keeps the same model under two providers apart", () => {
    expect(providerModelSeriesKey("claude_code", "opus")).not.toBe(
      providerModelSeriesKey("cursor", "opus"),
    );
  });

  it("folds thinking levels into one series for the same provider and model", () => {
    const chart = buildUsageChart({
      entries: [
        entry({ thinking_effort: "low", input_tokens: 1, output_tokens: 1 }),
        entry({ thinking_effort: "high", input_tokens: 2, output_tokens: 2 }),
      ],
      metric: "total",
      seriesKeyOf: (row) => providerModelSeriesKey(row.provider_id, row.model_id),
      labelOf: identity,
      axis: dayAxis(1, "2026-07-25"),
    });

    expect(chart.series).toHaveLength(1);
    expect(chart.series[0].value).toBe(6);
  });
});
