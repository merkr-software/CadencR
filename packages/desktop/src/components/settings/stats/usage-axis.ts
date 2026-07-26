/**
 * Where a key press moves the chart's single tab stop, or `null` for a key the
 * chart does not own — which must keep bubbling, or Tab could never leave.
 *
 * Home/End included because a 90-day timeline is a long way to arrow across.
 */
export function nextFocusIndex(key: string, current: number, dayCount: number): number | null {
  if (dayCount === 0) return null;
  const last = dayCount - 1;
  switch (key) {
    case "ArrowLeft":
      return Math.max(0, current - 1);
    case "ArrowRight":
      return Math.min(last, current + 1);
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}

/** Most x-axis labels a timeline can show before "Jun 20" starts colliding. */
const MAX_TICKS = 6;

/**
 * Which columns get an x-axis label. Always the first and last, then as many
 * evenly-spaced ticks in between as fit without colliding.
 *
 * Lives outside the chart component so exporting it does not break the
 * component file's Fast Refresh boundary.
 */
export function axisTickIndexes(dayCount: number): Set<number> {
  if (dayCount === 0) return new Set();
  const maxTicks = Math.min(MAX_TICKS, dayCount);
  const step = Math.max(1, Math.ceil((dayCount - 1) / Math.max(1, maxTicks - 1)));
  const ticks = new Set<number>();
  for (let index = 0; index < dayCount - 1; index += step) ticks.add(index);
  ticks.add(dayCount - 1);
  // The generated tick before the last can crowd it; drop it if adjacent.
  if (ticks.has(dayCount - 2) && dayCount > 2) ticks.delete(dayCount - 2);
  return ticks;
}
