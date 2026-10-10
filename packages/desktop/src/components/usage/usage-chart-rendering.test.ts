import { describe, expect, it } from "vitest";
import { axisTickIndexes, nextFocusIndex } from "./usage-axis";
import {
  seriesColor,
  formatChartTokens,
  formatCompactTokens,
  formatDayLabel,
  formatShare,
} from "./usage-chart-palette";
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

describe("nextFocusIndex", () => {
  it("walks day by day and stops at both ends", () => {
    expect(nextFocusIndex("ArrowRight", 0, 30)).toBe(1);
    expect(nextFocusIndex("ArrowLeft", 5, 30)).toBe(4);
    expect(nextFocusIndex("ArrowLeft", 0, 30)).toBe(0);
    expect(nextFocusIndex("ArrowRight", 29, 30)).toBe(29);
  });

  // -1 is "focus is not on a column yet"; either arrow should land on a real day.
  it("starts at the first day when nothing is focused yet", () => {
    expect(nextFocusIndex("ArrowRight", -1, 30)).toBe(0);
    expect(nextFocusIndex("ArrowLeft", -1, 30)).toBe(0);
  });

  it("jumps to either end of a long range", () => {
    expect(nextFocusIndex("Home", 45, 90)).toBe(0);
    expect(nextFocusIndex("End", 45, 90)).toBe(89);
  });

  // Anything else has to keep bubbling, or Tab could never leave the chart.
  it("ignores keys it does not own", () => {
    for (const key of ["Tab", "Enter", " ", "ArrowUp", "a"]) {
      expect(nextFocusIndex(key, 3, 30)).toBeNull();
    }
    expect(nextFocusIndex("ArrowRight", 0, 0)).toBeNull();
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
  it("never rounds a non-zero share down to a misleading 0%", () => {
    expect(formatShare(4_200_000, 5_600_000_000)).toBe("<1%");
    expect(formatShare(0, 5_600_000_000)).toBe("0%");
    expect(formatShare(1, 2)).toBe("50%");
  });

  it("compacts large token counts", () => {
    expect(formatCompactTokens(1_234_000)).toMatch(/1\.2M/);
    expect(formatCompactTokens(0)).toBe("0");
  });

  it("reads chart figures as two significant digits in K, M and B", () => {
    expect(formatChartTokens(1_801_292_560)).toBe("1.8B");
    expect(formatChartTokens(320_456_000)).toBe("320M");
    expect(formatChartTokens(1_520)).toBe("1.5K");
    expect(formatChartTokens(12_345)).toBe("12K");
  });

  it("labels a day in UTC, not the local zone", () => {
    // 00:30 UTC would be the previous day in any negative-offset zone.
    expect(formatDayLabel("2026-07-25")).toMatch(/25/);
  });

  it("passes an unparseable day through untouched", () => {
    expect(formatDayLabel("nope")).toBe("nope");
  });
});
