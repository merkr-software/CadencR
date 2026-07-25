import { describe, expect, it } from "vitest";
import { axisTickIndexes } from "./usage-axis";
import { seriesColor, formatCompactWords, formatDayLabel } from "./usage-chart-palette";
import { MAX_COLORED_SERIES } from "./usage-stats-model";

describe("axisTickIndexes", () => {
  it("always labels the first and last day", () => {
    for (const dayCount of [2, 7, 30, 90]) {
      const ticks = axisTickIndexes(dayCount);
      expect(ticks.has(0)).toBe(true);
      expect(ticks.has(dayCount - 1)).toBe(true);
    }
  });

  it("never crowds the last label with its neighbour", () => {
    for (const dayCount of [3, 7, 30, 90]) {
      expect(axisTickIndexes(dayCount).has(dayCount - 2)).toBe(false);
    }
  });

  it("keeps the label count low enough not to collide", () => {
    expect(axisTickIndexes(90).size).toBeLessThanOrEqual(6);
    expect(axisTickIndexes(30).size).toBeLessThanOrEqual(6);
  });

  it("handles degenerate ranges", () => {
    expect(axisTickIndexes(0).size).toBe(0);
    expect([...axisTickIndexes(1)]).toEqual([0]);
  });
});

describe("seriesColor", () => {
  it("gives every palette slot a distinct color", () => {
    const assigned = Array.from({ length: MAX_COLORED_SERIES }, (_, index) => seriesColor(index));
    expect(new Set(assigned).size).toBe(MAX_COLORED_SERIES);
  });

  it("falls back to the neutral bucket color past the palette", () => {
    expect(seriesColor(-1)).toBe(seriesColor(MAX_COLORED_SERIES));
    expect(seriesColor(-1)).not.toBe(seriesColor(0));
  });

  it("only emits theme tokens, never hardcoded hexes", () => {
    for (let index = -1; index <= MAX_COLORED_SERIES; index += 1) {
      expect(seriesColor(index)).toMatch(/^var\(--/);
    }
  });
});

describe("formatting", () => {
  it("compacts large word counts", () => {
    expect(formatCompactWords(1_234_000)).toMatch(/1\.2M/);
    expect(formatCompactWords(0)).toBe("0");
  });

  it("labels a day in UTC, not the local zone", () => {
    // 00:30 UTC would be the previous day in any negative-offset zone.
    expect(formatDayLabel("2026-07-25")).toMatch(/25/);
  });

  it("passes an unparseable day through untouched", () => {
    expect(formatDayLabel("nope")).toBe("nope");
  });
});
