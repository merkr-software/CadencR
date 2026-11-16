/**
 * Where each composer instrument sits: one row under the editor while
 * everything fits, two rows once it doesn't.
 *
 * One row: auto-scroll │ mode │ model │ access on the left; read-outs, tools,
 * attach and the run controls on the right.
 *
 * Two rows split by meaning, never by measured widths, so the card always
 * reads the same:
 * - a session header atop the card — how the agent runs: mode │ model ·
 *   effort · fast on the left, access / session config on the right;
 * - the row under the editor — this conversation and this message:
 *   auto-scroll on the left (the transcript's side); compaction hint, context
 *   meter, todos, history, ⋯, attach and Send / Stop / Steer on the right,
 *   where the hand expects Send.
 */

/** The four zones of the card's two instrument rows. */
export const ZONES = ["topLeft", "topRight", "bottomLeft", "bottomRight"] as const;
export type Zone = (typeof ZONES)[number];

/** The session settings, which open the single row. */
export const SESSION_SLOTS = ["autoscroll", "mode", "model", "access"] as const;
/** Read-outs, tools and run controls: always the bottom right. */
const TRAILING_SLOTS = [
  "compaction",
  "meter",
  "todos",
  "history",
  "assist",
  "stop-arm",
  "actions",
] as const;
export const INSTRUMENT_SLOTS = [...SESSION_SLOTS, ...TRAILING_SLOTS];
export type InstrumentSlot = (typeof INSTRUMENT_SLOTS)[number];

const SINGLE_ROW_ZONES: Record<Zone, readonly InstrumentSlot[]> = {
  topLeft: [],
  topRight: [],
  bottomLeft: SESSION_SLOTS,
  bottomRight: TRAILING_SLOTS,
};

const SPLIT_ZONES: Record<Zone, readonly InstrumentSlot[]> = {
  topLeft: ["mode", "model"],
  topRight: ["access"],
  bottomLeft: ["autoscroll"],
  bottomRight: TRAILING_SLOTS,
};

/** The session controls that rise into the header when the row splits. */
const HEADER_SLOTS = [...SPLIT_ZONES.topLeft, ...SPLIT_ZONES.topRight];

export function zoneSlots(split: boolean): Record<Zone, readonly InstrumentSlot[]> {
  return split ? SPLIT_ZONES : SINGLE_ROW_ZONES;
}

/** Natural widths per slot; 0 for a slot with nothing to show. */
export type InstrumentWidths = Record<InstrumentSlot, number>;

export interface InstrumentSpacing {
  /** The row's content width. */
  available: number;
  /**
   * Row width below which the instruments drop their labels (composer.css).
   * One row never relies on that: below it the card stays on two rows, so
   * narrowing a pane goes one row → two rows → two compact rows, and never
   * back to a single cramped row.
   */
  compactBelow: number;
  /** Gap between the left and right halves of a row. */
  rowGap: number;
  /** Gap between session instruments, plus the hairline space between them. */
  sessionGap: number;
  /** Gap between the trailing instruments. */
  trailingGap: number;
}

/** Slack a single row must regain before two rows fold back into one. */
const UNSPLIT_SLACK_PX = 8;
/** Sub-pixel rounding between the row and its measured instruments. */
const FIT_TOLERANCE_PX = 0.5;

function runWidth(widths: readonly number[], gap: number): number {
  const shown = widths.filter((width) => width > 0);
  if (shown.length === 0) return 0;
  return shown.reduce((sum, width) => sum + width, 0) + (shown.length - 1) * gap;
}

export function singleRowWidth(widths: InstrumentWidths, spacing: InstrumentSpacing): number {
  const left = runWidth(
    SESSION_SLOTS.map((slot) => widths[slot]),
    spacing.sessionGap,
  );
  const right = runWidth(
    TRAILING_SLOTS.map((slot) => widths[slot]),
    spacing.trailingGap,
  );
  return left > 0 && right > 0 ? left + spacing.rowGap + right : left + right;
}

/**
 * Whether the instruments take two rows. They split once one row no longer
 * fits at full labels (or the row is narrow enough to compact them); once
 * split, they fold back only with room to spare, so a row that fits to the
 * pixel can't flip on every resize event. Without a session header to show,
 * there is nothing to lift.
 */
export function chooseSplit(
  split: boolean,
  widths: InstrumentWidths,
  spacing: InstrumentSpacing,
): boolean {
  if (HEADER_SLOTS.every((slot) => widths[slot] === 0)) return false;
  const slack = split ? UNSPLIT_SLACK_PX : FIT_TOLERANCE_PX;
  const fits = singleRowWidth(widths, spacing) + slack <= spacing.available;
  return !(fits && spacing.available >= spacing.compactBelow);
}
