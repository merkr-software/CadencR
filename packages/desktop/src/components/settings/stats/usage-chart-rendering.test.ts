import { describe, expect, it } from "vitest";
import { axisTickIndexes, nextFocusIndex } from "./usage-axis";
import { seriesColor, formatCompactTokens, formatDayLabel } from "./usage-chart-palette";
import { MAX_COLORED_SERIES } from "./usage-stats-model";
import { MIN_SEGMENT_PX, SEGMENT_GAP_PX, segmentHeights } from "./usage-bar-heights";

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

describe("segmentHeights", () => {
  const PLOT = 156;
  const stackHeight = (heights: number[]): number =>
    heights.reduce((sum, height) => sum + height, 0) + SEGMENT_GAP_PX * (heights.length - 1);

  it("makes the busiest day reach the axis maximum, gaps included", () => {
    for (const values of [[100], [60, 40], [50, 30, 15, 5]]) {
      const max = values.reduce((sum, value) => sum + value, 0);
      expect(stackHeight(segmentHeights(values, max, PLOT))).toBeCloseTo(PLOT, 5);
    }
  });

  it("keeps a quiet day proportional to the busiest one", () => {
    const [half] = segmentHeights([50], 100, PLOT);
    expect(half).toBeCloseTo(PLOT / 2, 5);
  });

  it("never renders a non-zero day thinner than the floor", () => {
    const heights = segmentHeights([1000, 1, 1, 1], 1003, PLOT);
    for (const height of heights) expect(height).toBeGreaterThanOrEqual(MIN_SEGMENT_PX);
  });

  it("pays for the floor out of the segments that have room, not out of the plot", () => {
    const heights = segmentHeights([1000, 1, 1, 1], 1003, PLOT);
    expect(stackHeight(heights)).toBeLessThanOrEqual(PLOT + 0.001);
    expect(heights[0]).toBeGreaterThan(PLOT * 0.8);
  });

  it("draws nothing for a series with no usage that day", () => {
    const [used, unused] = segmentHeights([100, 0], 100, PLOT);
    expect(unused).toBe(0);
    expect(used).toBeGreaterThan(0);
  });

  it("keeps the busiest day at the axis maximum when a series is empty", () => {
    const heights = segmentHeights([100, 0, 0], 100, PLOT);
    expect(stackHeight(heights)).toBeCloseTo(PLOT, 5);
  });

  it("handles empty and zero-max stacks", () => {
    expect(segmentHeights([], 100, PLOT)).toEqual([]);
    expect(segmentHeights([5], 0, PLOT)).toEqual([0]);
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
  it("compacts large token counts", () => {
    expect(formatCompactTokens(1_234_000)).toMatch(/1\.2M/);
    expect(formatCompactTokens(0)).toBe("0");
  });

  it("labels a day in UTC, not the local zone", () => {
    // 00:30 UTC would be the previous day in any negative-offset zone.
    expect(formatDayLabel("2026-07-25")).toMatch(/25/);
  });

  it("passes an unparseable day through untouched", () => {
    expect(formatDayLabel("nope")).toBe("nope");
  });
});
