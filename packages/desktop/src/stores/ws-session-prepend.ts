import { compactFlowBlockFrom, countRenderableDisplayRows } from "@/lib/agent-stream-display";
import type { DisplayRowMode } from "@/types/agent-stream";
import type { AgentBlockData } from "@/types/agent-block";
import { blocksPatchWithDerived } from "./ws-message-processing";
import type { StoreAccessors } from "./ws-envelope-handler";
import type { HistoryGap } from "./ws-history-gaps";
import { updateSession } from "./ws-session-types";
import { mergeCanonicalBlocks, sameMessageIdentity } from "./ws-user-message-reconciliation";

function preserveCompactFlowPrependSeam(
  merged: AgentBlockData[],
  boundary: AgentBlockData | undefined,
): AgentBlockData[] {
  if (!boundary) return merged;
  const exactIndex = merged.indexOf(boundary);
  const index =
    exactIndex >= 0
      ? exactIndex
      : merged.findIndex((block) => sameMessageIdentity(block, boundary));
  if (index < 0) return merged;
  const mergedBoundary = merged[index];
  if (mergedBoundary.compactFlowBreakBefore) return merged;
  const next = [...merged];
  next[index] = { ...mergedBoundary, compactFlowBreakBefore: true };
  return next;
}

interface HistoryMergeOptions {
  /**
   * The blocks land above the reader (an older page under a gap's row, a far
   * prompt's turn): bump `historyPrependDisplayOffset` by the rows added above
   * the rows below them, so Virtuoso keeps their index — and with it their
   * measured sizes — aligned. False for blocks landing below the reader.
   */
  shiftsRowsBelow: boolean;
  /** The session's gaps once these blocks are in; each gap is a row of its own. */
  historyGaps: HistoryGap[];
  /**
   * Database id of the first loaded message below the landing blocks: in
   * compact mode, a run starting there stays its own row instead of absorbing
   * the page's trailing steps (which would re-key a row already on screen).
   */
  seamFromId: number;
}

/**
 * Merges blocks fetched from saved history — a page filling a gap, or one
 * prompt's turn — into the transcript by database order, in the same store
 * update as the gaps they close. Returns null when the session is gone.
 */
export function mergeHistoryBlocks(
  ctx: StoreAccessors,
  sessionId: string,
  fetched: AgentBlockData[],
  displayMode: DisplayRowMode | undefined,
  { shiftsRowsBelow, historyGaps, seamFromId }: HistoryMergeOptions,
): { addedBlocks: number; addedDisplayRows: number } | null {
  const current = ctx.get().sessions[sessionId];
  if (!current) return null;
  const compactBoundary = displayMode?.compactMode
    ? compactFlowBlockFrom(current.blocks, seamFromId)
    : undefined;
  const merged = mergeCanonicalBlocks(current.blocks, fetched, current.promptReceiptsAtSubmission);
  const addedBlocks = merged.length - current.blocks.length;
  const mergedBlocks =
    addedBlocks > 0 ? preserveCompactFlowPrependSeam(merged, compactBoundary) : merged;
  // Use the actual growth in rendered rows, not the fetched chunk's rows in
  // isolation — under summary/compact mode a segment can span the chunk
  // boundary, so the net delta is what keeps `firstItemIndex` aligned. Gap
  // rows count too: one closing (or splitting) above the reader moves the rows
  // below it like any other row.
  const addedDisplayRows =
    countRenderableDisplayRows(mergedBlocks, displayMode, historyGaps) -
    countRenderableDisplayRows(current.blocks, displayMode, current.historyGaps);
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      ...blocksPatchWithDerived(current.streamingState, mergedBlocks),
      historyPrependDisplayOffset:
        current.historyPrependDisplayOffset + (shiftsRowsBelow ? addedDisplayRows : 0),
      historyGaps,
    }),
  );
  return { addedBlocks, addedDisplayRows };
}
