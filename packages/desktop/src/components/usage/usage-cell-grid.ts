/**
 * Square-cell stacks: each day is a column of square cells, one stack per day.
 *
 * Sizing happens in CSS (`cqw` against the chart's `@container`), not in
 * JavaScript, so the squares track the pane width with no layout reads.
 */

export const CELL_DENSITY = {
  /** The Settings chart: a tall grid with the dates under it. */
  comfortable: { rows: 12, dates: true, rounded: false },
  /** The overview above the tips: the grid alone, its corners rounded like the tips card. */
  compact: { rows: 10, dates: false, rounded: true },
} as const;

export type UsageDensity = keyof typeof CELL_DENSITY;

/** Surface gap between cells, both across a row and up a stack. */
export const CELL_GAP_PX = 2;

/** Caps the cell side, so a 7-day chart does not grow into huge squares. */
const MAX_CELL_PX = 24;

/** Height of the date labels under the plot. In rem, so it follows the root font size. */
export const DATE_BAND_CSS = "1.125rem";

/**
 * Sets `--cell`, the largest square side that still fits every column across
 * the container. Needs an ancestor with `@container`.
 */
export function cellScopeStyle(days: number): React.CSSProperties {
  const gaps = Math.max(0, days - 1) * CELL_GAP_PX;
  return {
    "--cell": `min(${MAX_CELL_PX}px, calc((100cqw - ${gaps}px) / ${days}))`,
  } as React.CSSProperties;
}

/**
 * The width of the whole grid: every cell and every gap. Columns sit at a fixed
 * pitch of one cell plus one gap, so both directions are spaced the same.
 */
export function gridWidthCss(days: number): string {
  return `calc(${days} * var(--cell) + ${Math.max(0, days - 1) * CELL_GAP_PX}px)`;
}

/** The left edge of column `index`, on the grid's pitch. */
export function columnLeftCss(index: number): string {
  return `calc(${index} * (var(--cell) + ${CELL_GAP_PX}px))`;
}

/** The horizontal centre of column `index`. */
export function columnCenterCss(index: number): string {
  return `calc(${columnLeftCss(index)} + var(--cell) / 2)`;
}

/** The height of a loaded chart, dates included, for placeholders standing in for it. */
export function chartHeightCss(density: UsageDensity): string {
  const { rows, dates } = CELL_DENSITY[density];
  const plot = `${rows} * var(--cell) + ${(rows - 1) * CELL_GAP_PX}px`;
  return `calc(${plot}${dates ? ` + ${DATE_BAND_CSS}` : ""})`;
}

/**
 * How many cells each series of one day gets, out of `rows`.
 *
 * The day's total fills `ceil(total / max * rows)` cells, so any usage shows at
 * least one cell. The cells are shared out in proportion to the usage, with the
 * largest remainder taking leftovers. A series that spent anything then keeps
 * one cell, borrowed from the largest. When there are more series than cells,
 * the largest claim one cell each; the exact values stay in the day's card.
 *
 * Returns one count per input value, in the same order.
 */
export function allocateCells(values: number[], max: number, rows: number): number[] {
  const counts = values.map(() => 0);
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (max <= 0 || total <= 0 || rows <= 0) return counts;

  const target = Math.min(rows, Math.max(1, Math.ceil((total / max) * rows)));
  const live = values.map((value, index) => ({ index, value })).filter(({ value }) => value > 0);

  if (live.length >= target) {
    live
      .sort((a, b) => b.value - a.value || a.index - b.index)
      .slice(0, target)
      .forEach(({ index }) => {
        counts[index] = 1;
      });
    return counts;
  }

  const quotas = live.map(({ value }) => (value / total) * target);
  const shares = quotas.map((quota) => Math.floor(quota));
  let leftover = target - shares.reduce((sum, share) => sum + share, 0);
  const byRemainder = quotas
    .map((quota, position) => ({ position, remainder: quota - Math.floor(quota) }))
    .sort((a, b) => b.remainder - a.remainder || a.position - b.position);
  for (const { position } of byRemainder) {
    if (leftover <= 0) break;
    shares[position] = shares[position]! + 1;
    leftover -= 1;
  }

  // A series that spent anything keeps a cell: borrow it from the largest.
  // The total is at least the number of live series, so a donor always exists.
  for (let position = 0; position < shares.length; position += 1) {
    if (shares[position] !== 0) continue;
    let donor = 0;
    for (let other = 1; other < shares.length; other += 1) {
      if (shares[other]! > shares[donor]!) donor = other;
    }
    shares[donor] = shares[donor]! - 1;
    shares[position] = 1;
  }

  live.forEach(({ index }, position) => {
    counts[index] = shares[position]!;
  });
  return counts;
}
