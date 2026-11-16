import { describe, expect, it } from "vitest";
import { allocateCells, chartHeightCss, DATE_BAND_CSS } from "./usage-cell-grid";

describe("allocateCells", () => {
  it("fills the whole stack for a day at the axis maximum", () => {
    expect(allocateCells([3, 1], 4, 4)).toEqual([3, 1]);
    expect(allocateCells([10], 10, 12)).toEqual([12]);
  });

  it("gives every series that spent anything at least one cell", () => {
    // A sliver of usage next to a big series still shows as a cell.
    const counts = allocateCells([1_000_000, 1], 1_000_000, 12);
    expect(counts[1]).toBeGreaterThanOrEqual(1);
  });

  it("never gives a series with no usage a cell", () => {
    expect(allocateCells([5, 0, 5], 10, 10)[1]).toBe(0);
  });

  it("shows any usage at all as at least one cell", () => {
    expect(allocateCells([1], 1_000_000_000, 12)).toEqual([1]);
  });

  it("never fills more cells than the stack has", () => {
    const counts = allocateCells([7, 5, 3, 2], 17, 12);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual(12);
  });

  it("keeps the shares in proportion to the day's usage", () => {
    // 3:1 over 8 cells is 6 and 2 exactly.
    expect(allocateCells([300, 100], 400, 8)).toEqual([6, 2]);
  });

  it("gives leftover cells to the largest remainders", () => {
    // Exact shares over 6 cells are 3, 1.8 and 1.2: the leftover cell goes to
    // the 1.8, the largest remainder.
    expect(allocateCells([5, 3, 2], 10, 6)).toEqual([3, 2, 1]);
  });

  it("keeps a small series visible by borrowing a cell from the largest", () => {
    expect(allocateCells([100, 1], 101, 4)).toEqual([3, 1]);
  });

  it("gives one cell each to the largest series when there are more series than cells", () => {
    expect(allocateCells([9, 8, 7, 6, 5], 35, 3)).toEqual([1, 1, 1, 0, 0]);
  });

  it("fills every row when a day is normalised to its own total, for the share view", () => {
    // 3:1 over all 12 rows, whatever the day's size.
    expect(allocateCells([3, 1], 4, 12)).toEqual([9, 3]);
    expect(allocateCells([30_000, 10_000], 40_000, 12)).toEqual([9, 3]);
  });

  it("handles empty input and a zero maximum", () => {
    expect(allocateCells([], 10, 12)).toEqual([]);
    expect(allocateCells([4, 2], 0, 12)).toEqual([0, 0]);
  });
});

describe("chartHeightCss", () => {
  it("adds the date band only to a density that shows dates", () => {
    expect(chartHeightCss("comfortable")).toContain(DATE_BAND_CSS);
    expect(chartHeightCss("compact")).not.toContain(DATE_BAND_CSS);
  });
});
