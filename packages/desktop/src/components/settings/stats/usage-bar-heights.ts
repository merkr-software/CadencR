/** Plot area a timeline's bars are drawn in. */
export const PLOT_HEIGHT_PX = 156;

/** Hairline between stacked segments, so the stack reads as parts of one bar. */
export const SEGMENT_GAP_PX = 2;

/** Keeps a non-zero day from vanishing into a sub-pixel sliver. */
export const MIN_SEGMENT_PX = 2;

/**
 * Pixel height of each segment of one day's stack.
 *
 * Computed in pixels rather than left to percentages, because the separators
 * between segments take real space out of the plot: percentage heights of the
 * *full* plot plus n−1 gaps overflow it, and flex would then quietly shrink the
 * segments — so the busiest day would render below the axis maximum it defines,
 * and the minimum-height floor would be silently violated.
 *
 * Segments are scaled against the height that is actually left after the gaps,
 * so a day at `max` fills the plot exactly. Where the minimum floor lifts the
 * stack past that, the excess is taken back from the segments that have room
 * above the floor, in proportion to how much room each has.
 */
export function segmentHeights(
  values: number[],
  max: number,
  plotHeight = PLOT_HEIGHT_PX,
): number[] {
  if (values.length === 0) return [];
  const available = Math.max(0, plotHeight - SEGMENT_GAP_PX * (values.length - 1));
  if (max <= 0 || available === 0) return values.map(() => 0);

  const heights = values.map((value) => Math.max(MIN_SEGMENT_PX, (value / max) * available));
  const overflow = heights.reduce((sum, height) => sum + height, 0) - available;
  if (overflow <= 0) return heights;

  const slack = heights.map((height) => Math.max(0, height - MIN_SEGMENT_PX));
  const totalSlack = slack.reduce((sum, room) => sum + room, 0);
  // Every segment is already at the floor: nothing left to give back.
  if (totalSlack === 0) return heights;

  const shrink = Math.min(1, overflow / totalSlack);
  return heights.map((height, index) => height - slack[index]! * shrink);
}
