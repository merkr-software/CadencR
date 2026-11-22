import type { AgentBlockData } from "@/types/agent-block";

/**
 * A stretch of a session's saved history the client has not loaded, between
 * two loaded messages. The transcript is not one contiguous window: the server
 * ships the session's first prompt ahead of the latest page, and the message
 * navigator loads a far prompt's turn on its own. Each such island leaves a
 * gap on both sides, which the stream renders as a row of its own and fills
 * as it comes near the viewport (see `useHistoryGapFiller`).
 *
 * Bounds are database ids of the session's messages, both exclusive: every
 * message with `afterId < id < beforeId` may be missing. `afterId` is null
 * when nothing older than `beforeId` is loaded.
 */
export interface HistoryGap {
  /** Stable while the gap shrinks from either side: it keys the gap's row. */
  id: string;
  afterId: number | null;
  beforeId: number;
}

/**
 * A renderable row in the agent stream. In every mode except "compact" each
 * block is its own row. In "compact" mode, each run of consecutive non-text
 * blocks (tool calls, thinking) folds into one `flow` row that renders as a
 * single line until the user unfolds it. A `gap` row stands for history that
 * is not loaded yet, between the rows on either side of it.
 */
export type DisplayItem = (
  | { kind: "block"; key: string; block: AgentBlockData }
  | { kind: "flow"; key: string; blocks: AgentBlockData[] }
  | { kind: "gap"; key: string; gap: HistoryGap }
) & {
  /** Padding under the row, set from the row after it (`spaceRows`). */
  spaceBelow?: number;
};

/**
 * Which display transforms are active, so row counts match what `AgentStream`
 * actually renders. Both default to off (Maximal, no summary).
 */
export interface DisplayRowMode {
  summaryMode?: boolean;
  compactMode?: boolean;
}
