import type { DisplayRowMode } from "@/types/agent-stream";
import type { StoreAccessors } from "./ws-envelope-handler";
import { type HistoryGapFillDirection, markPageLoaded } from "./ws-history-gaps";
import { fetchNewerPage, fetchOlderPage } from "./ws-history-pages";
import { mergeHistoryBlocks } from "./ws-session-prepend";

/**
 * Upper bound of pages fetched per fill while no new display row appears.
 * Under summary/compact display an agent-heavy page can collapse entirely into
 * an existing recap row, so a single page often renders nothing.
 */
const MAX_PAGES_PER_FILL = 10;

const NO_PROGRESS = "The service returned no messages for this part of the conversation.";

export interface FillHistoryGapOptions {
  displayMode?: DisplayRowMode;
  /**
   * Read before each page lands: false stops the fill there (a jump holds the
   * view, the workspace went hidden, the conversation changed), the gap left
   * as it is.
   */
  shouldContinue?: () => boolean;
}

/**
 * Loads one page into a history gap from the side the reader is on. Returns
 * whether the gap is still open and how many display rows the page added;
 * null when the page did not land.
 */
async function fillGapPage(
  ctx: StoreAccessors,
  sessionId: string,
  gapId: string,
  direction: HistoryGapFillDirection,
  { displayMode, shouldContinue }: FillHistoryGapOptions,
): Promise<{ open: boolean; addedDisplayRows: number } | null> {
  const session = ctx.get().sessions[sessionId];
  const gap = session?.historyGaps.find((candidate) => candidate.id === gapId);
  if (!session || !gap || session.featureId === null || session.sessionDbId === null) return null;
  // With nothing loaded above the gap, only its lower side can fill.
  const fillFrom = direction === "newer" ? gap.afterId : null;
  const downward = fillFrom !== null;
  const page = downward
    ? await fetchNewerPage(session.featureId, session.sessionDbId, fillFrom, gap.beforeId)
    : await fetchOlderPage(session.featureId, session.sessionDbId, gap.beforeId, gap.afterId);
  if (page.from > page.to) throw new Error(NO_PROGRESS);

  // The request was in flight. Another load (a prompt's turn, a snapshot, a
  // clear) may have moved this gap: a page fetched for the old bounds could
  // overlap rows now loaded and repeat their text, so it is dropped.
  const current = ctx.get().sessions[sessionId];
  const now = current?.historyGaps.find((candidate) => candidate.id === gapId);
  if (!current || !now || now.afterId !== gap.afterId || now.beforeId !== gap.beforeId) return null;
  if (shouldContinue && !shouldContinue()) return null;
  const historyGaps = markPageLoaded(current.historyGaps, page.blocks, page.from, page.to);
  const added = mergeHistoryBlocks(ctx, sessionId, page.blocks, displayMode, {
    // An older page lands under the gap's row, above the reader: the rows
    // below it keep their index only if Virtuoso is told they moved down.
    // A newer page lands below the reader, who must not move.
    shiftsRowsBelow: !downward,
    historyGaps,
    seamFromId: gap.beforeId,
  });
  if (!added) return null;
  return {
    open: historyGaps.some((candidate) => candidate.id === gapId),
    addedDisplayRows: added.addedDisplayRows,
  };
}

/**
 * Loads a history gap's messages from `direction`'s side, page after page,
 * until one adds a visible row or the gap closes — so a page that collapses
 * into an existing row never reads as a dead scroll. Stops early, the gap as
 * the last landed page left it, when `shouldContinue` says so or a page could
 * not land. Rejects with what went wrong.
 */
export async function fillSessionHistoryGap(
  ctx: StoreAccessors,
  sessionId: string,
  gapId: string,
  direction: HistoryGapFillDirection,
  options: FillHistoryGapOptions = {},
): Promise<void> {
  for (let page = 0; page < MAX_PAGES_PER_FILL; page += 1) {
    const result = await fillGapPage(ctx, sessionId, gapId, direction, options);
    if (!result || !result.open || result.addedDisplayRows > 0) return;
  }
}
