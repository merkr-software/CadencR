/** A rectangle in CSS pixels. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Placed<T> {
  item: T;
  rect: Rect;
}

/** Worst aspect ratio of a row laid along a side of length `side`. */
function worstRatio(areas: number[], side: number): number {
  const sum = areas.reduce((total, area) => total + area, 0);
  const max = Math.max(...areas);
  const min = Math.min(...areas);
  const sideSq = side * side;
  const sumSq = sum * sum;
  return Math.max((sideSq * max) / sumSq, sumSq / (sideSq * min));
}

/** Lays one row along the shorter side of `rect`; returns what is left. */
function layoutRow<T>(row: { item: T; area: number }[], rect: Rect, out: Placed<T>[]): Rect {
  const sum = row.reduce((total, entry) => total + entry.area, 0);
  const horizontal = rect.width >= rect.height;
  const thickness = horizontal ? sum / rect.height : sum / rect.width;
  let offset = 0;
  for (const entry of row) {
    const length = entry.area / thickness;
    out.push({
      item: entry.item,
      rect: horizontal
        ? { x: rect.x, y: rect.y + offset, width: thickness, height: length }
        : { x: rect.x + offset, y: rect.y, width: length, height: thickness },
    });
    offset += length;
  }
  return horizontal
    ? { x: rect.x + thickness, y: rect.y, width: rect.width - thickness, height: rect.height }
    : { x: rect.x, y: rect.y + thickness, width: rect.width, height: rect.height - thickness };
}

/**
 * Squarified treemap (Bruls, Huizing, van Wijk): tiles areas proportional to
 * `weight` into `rect`, keeping each tile as close to square as it can.
 * `items` should be sorted by weight, largest first.
 */
export function squarify<T>(items: T[], weight: (item: T) => number, rect: Rect): Placed<T>[] {
  const total = items.reduce((sum, item) => sum + weight(item), 0);
  if (total <= 0 || rect.width <= 0 || rect.height <= 0) return [];
  const scale = (rect.width * rect.height) / total;
  const queue = items.map((item) => ({ item, area: weight(item) * scale }));
  const out: Placed<T>[] = [];
  let free = rect;
  let row: typeof queue = [];
  const areas = (entries: typeof queue) => entries.map((entry) => entry.area);
  for (const entry of queue) {
    const side = Math.min(free.width, free.height);
    const candidate = [...row, entry];
    // Grow the row while that keeps its tiles squarer; otherwise start a new one.
    if (row.length === 0 || worstRatio(areas(candidate), side) <= worstRatio(areas(row), side)) {
      row = candidate;
    } else {
      free = layoutRow(row, free, out);
      row = [entry];
    }
  }
  if (row.length > 0) layoutRow(row, free, out);
  return out;
}

/** Shrinks a rect by `gap` on every side (never below zero). */
export function inset(rect: Rect, gap: number): Rect {
  return {
    x: rect.x + gap,
    y: rect.y + gap,
    width: Math.max(0, rect.width - gap * 2),
    height: Math.max(0, rect.height - gap * 2),
  };
}
