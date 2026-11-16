/** Narrowest a card gets before the grid drops a column: wide enough for the
 *  two-line header, the composer chips and a readable transcript measure. */
const MIN_AGENT_CARD_WIDTH = 400;
/** Horizontal padding the grid puts around its rows (`px-1.5` on the row and
 *  on each panel), so the fit counts usable width only. */
const GRID_GUTTER = 12;
/** How much of the next row stays visible under a full row: its header, so
 *  the grid always shows there is more below. */
const NEXT_ROW_PEEK = 64;
const MIN_DEFAULT_ROW_HEIGHT = 420;
const MAX_DEFAULT_ROW_HEIGHT = 760;
/** Before the grid area is measured. */
const UNMEASURED_ROW_HEIGHT = 640;

/**
 * How many cards a row shows: as many as fit at `MIN_AGENT_CARD_WIDTH`, never
 * more than the user's maximum, and never more than there are agents (two
 * agents share the width instead of leaving a hole for a third).
 */
export function effectiveAgentColumns(
  width: number | null,
  maxColumns: number,
  agentCount: number,
): number {
  const fit =
    width == null
      ? maxColumns
      : Math.floor((width - GRID_GUTTER) / (MIN_AGENT_CARD_WIDTH + GRID_GUTTER));
  return Math.max(1, Math.min(maxColumns, fit, Math.max(1, agentCount)));
}

/** A row tall enough to fill the grid area, minus a peek of the next row. */
export function defaultAgentRowHeight(height: number | null): number {
  if (height == null) return UNMEASURED_ROW_HEIGHT;
  return Math.max(MIN_DEFAULT_ROW_HEIGHT, Math.min(MAX_DEFAULT_ROW_HEIGHT, height - NEXT_ROW_PEEK));
}
