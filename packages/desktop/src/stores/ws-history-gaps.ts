import type { AgentBlockData } from "@/types/agent-block";
import type { HistoryGap } from "@/types/agent-stream";
import { blockMessageDbId } from "./ws-message-identity";

export type { HistoryGap };

/** Which side of a gap a fill loads from, toward the reader. */
export type HistoryGapFillDirection =
  /** The messages just above `beforeId`, newest first (`before` paging). */
  | "older"
  /** The messages just below `afterId`, oldest first (`after` paging). */
  | "newer";

/** No gap: one shared empty list, so an unchanged value keeps its identity. */
export const NO_HISTORY_GAPS: HistoryGap[] = [];

let nextGapId = 0;

function newGapId(): string {
  nextGapId += 1;
  return `history-gap-${nextGapId}`;
}

/** No integer id strictly between the bounds: nothing can be missing. */
function isEmptyGap(afterId: number | null, beforeId: number): boolean {
  return afterId !== null && beforeId - afterId <= 1;
}

/**
 * The gaps left once every message with `from <= id <= to` is loaded. Open
 * bounds (`-Infinity`, `Infinity`) say the range runs to the start or the end
 * of the session. A gap the range cuts in two keeps its id on the older part.
 * Gaps stay in database order; when none changes, `gaps` itself comes back,
 * so an update that closes nothing re-renders nothing.
 */
export function markHistoryLoaded(gaps: HistoryGap[], from: number, to: number): HistoryGap[] {
  let changed = false;
  const next: HistoryGap[] = [];
  for (const gap of gaps) {
    const after = gap.afterId ?? -Infinity;
    if (to <= after || from >= gap.beforeId) {
      next.push(gap);
      continue;
    }
    changed = true;
    const older =
      from > after && !isEmptyGap(gap.afterId, from) ? { ...gap, beforeId: from } : null;
    const newer = to < gap.beforeId && !isEmptyGap(to, gap.beforeId) ? to : null;
    if (older) next.push(older);
    if (newer !== null) {
      next.push({ id: older ? newGapId() : gap.id, afterId: newer, beforeId: gap.beforeId });
    }
  }
  return changed ? next : gaps;
}

/**
 * {@link markHistoryLoaded} for a page covering `from..to`, plus the rows the
 * server ships outside it (the session's first prompt ahead of the latest
 * page, the tool call a page's result belongs to): each is an island of its
 * own, its neighbours unknown, so the gap around it splits and it renders
 * between two gap rows instead of beside rows it does not follow.
 */
export function markPageLoaded(
  gaps: HistoryGap[],
  blocks: readonly AgentBlockData[],
  from: number,
  to: number,
): HistoryGap[] {
  let next = markHistoryLoaded(gaps, from, to);
  for (const block of blocks) {
    const id = blockMessageDbId(block);
    if (id !== null && (id < from || id > to)) next = markHistoryLoaded(next, id, id);
  }
  return next;
}

/** What a history snapshot (the latest page of a session) says is loaded. */
export interface HistorySnapshot {
  blocks: readonly AgentBlockData[];
  hasMore: boolean;
  oldestMessageId: number | null;
}

/**
 * The gaps of a transcript hydrated from a snapshot: the latest page starts at
 * `oldestMessageId`, and everything before it is a gap, but for the rows
 * shipped ahead of the page (see {@link markPageLoaded}).
 */
export function snapshotHistoryGaps({
  blocks,
  hasMore,
  oldestMessageId,
}: HistorySnapshot): HistoryGap[] {
  if (!hasMore || oldestMessageId === null) return NO_HISTORY_GAPS;
  const unloaded: HistoryGap[] = [{ id: newGapId(), afterId: null, beforeId: oldestMessageId }];
  return markPageLoaded(unloaded, blocks, oldestMessageId, Infinity);
}
