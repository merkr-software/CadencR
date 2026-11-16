import { countRenderableDisplayRows, leadingCompactFlowBlock } from "@/lib/agent-stream-display";
import type { DisplayRowMode } from "@/types/agent-stream";
import type { AgentBlockData } from "@/types/agent-block";
import { blocksPatchWithDerived } from "./ws-message-processing";
import type { StoreAccessors } from "./ws-envelope-handler";
import { updateSession, type SessionEntry } from "./ws-session-types";
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

/**
 * Merges blocks fetched from history ahead of the loaded window — an older
 * page, or one prompt's turn — and bumps `historyPrependDisplayOffset` so
 * Virtuoso's viewport stays where it was. `patch` rides along in the same
 * store update. Returns null when the session is gone.
 */
export function prependHistoryBlocks(
  ctx: StoreAccessors,
  sessionId: string,
  fetched: AgentBlockData[],
  displayMode: DisplayRowMode | undefined,
  patch: Partial<SessionEntry> = {},
): { addedBlocks: number; addedDisplayRows: number } | null {
  const current = ctx.get().sessions[sessionId];
  if (!current) return null;
  const compactBoundary = displayMode?.compactMode
    ? leadingCompactFlowBlock(current.blocks)
    : undefined;
  const merged = mergeCanonicalBlocks(current.blocks, fetched);
  const addedBlocks = merged.length - current.blocks.length;
  const mergedBlocks =
    addedBlocks > 0 ? preserveCompactFlowPrependSeam(merged, compactBoundary) : merged;
  // Use the actual growth in rendered rows, not the fetched chunk's rows in
  // isolation — under summary/compact mode a segment can span the chunk
  // boundary, so the net delta is what keeps `firstItemIndex` aligned.
  const addedDisplayRows =
    countRenderableDisplayRows(mergedBlocks, displayMode) -
    countRenderableDisplayRows(current.blocks, displayMode);
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      ...blocksPatchWithDerived(current.streamingState, mergedBlocks),
      historyPrependDisplayOffset: current.historyPrependDisplayOffset + addedDisplayRows,
      ...patch,
    }),
  );
  return { addedBlocks, addedDisplayRows };
}
