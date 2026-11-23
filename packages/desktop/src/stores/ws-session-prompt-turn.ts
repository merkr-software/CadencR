import type { DisplayRowMode } from "@/types/agent-stream";
import type { StoreAccessors } from "./ws-envelope-handler";
import { blockMessageDbId } from "./ws-message-identity";
import { type HistoryGap, markPageLoaded } from "./ws-history-gaps";
import { fetchNewerPage } from "./ws-history-pages";
import { mergeHistoryBlocks } from "./ws-session-prepend";

/** Fetches tried when other loads keep moving the prompt's gap meanwhile. */
const MAX_TURN_ATTEMPTS = 3;
const KEPT_MOVING = "The conversation kept changing while that message loaded.";

function gapHolding(gaps: readonly HistoryGap[], messageDbId: number): HistoryGap | undefined {
  return gaps.find(
    ({ afterId, beforeId }) => (afterId ?? -Infinity) < messageDbId && messageDbId < beforeId,
  );
}

function holdsPrompt(ctx: StoreAccessors, sessionId: string, messageDbId: number): boolean {
  const blocks = ctx.get().sessions[sessionId]?.blocks ?? [];
  return blocks.some((block) => blockMessageDbId(block) === messageDbId);
}

/**
 * Makes one prompt that sits in unloaded history reachable, for the message
 * navigator: fetches the prompt and the start of its turn (one forward page,
 * kept inside the gap the prompt sits in) and merges it in by database order
 * — the same shape as the first-prompt island the server ships ahead of the
 * latest page.
 *
 * Paging back to an old prompt instead would pull in every message in
 * between, and a long agentic session holds thousands per turn. The turn
 * becomes an island in its gap: the gap splits in two, one row on each side,
 * and each fills as the reader scrolls toward it. A gap fill that moves the
 * gap while the turn is in flight makes the page stale (it could overlap rows
 * now loaded); it is fetched again for the new bounds, a few times at most.
 *
 * Resolves with whether the prompt is now in the transcript; rejects when its
 * gap never held still long enough.
 */
export async function loadSessionPromptTurn(
  ctx: StoreAccessors,
  sessionId: string,
  messageDbId: number,
  displayMode?: DisplayRowMode,
): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_TURN_ATTEMPTS; attempt += 1) {
    const session = ctx.get().sessions[sessionId];
    if (!session?.featureId || !session.sessionDbId) return false;
    const gap = gapHolding(session.historyGaps, messageDbId);
    if (!gap) return holdsPrompt(ctx, sessionId, messageDbId);
    // `after` is exclusive: start the forward page on the prompt itself.
    const page = await fetchNewerPage(
      session.featureId,
      session.sessionDbId,
      messageDbId - 1,
      gap.beforeId,
    );
    if (!page.blocks.some((block) => blockMessageDbId(block) === messageDbId)) return false;

    const current = ctx.get().sessions[sessionId];
    if (!current) return false;
    const now = gapHolding(current.historyGaps, messageDbId);
    if (now && (now.afterId !== gap.afterId || now.beforeId !== gap.beforeId)) continue;
    if (!now) return holdsPrompt(ctx, sessionId, messageDbId);
    const to = Math.max(messageDbId, page.to);
    // The turn lands far above the reader, who jumps to it next.
    const merged = mergeHistoryBlocks(ctx, sessionId, page.blocks, displayMode, {
      shiftsRowsBelow: true,
      historyGaps: markPageLoaded(current.historyGaps, page.blocks, messageDbId, to),
      seamFromId: to + 1,
    });
    return merged !== null;
  }
  if (holdsPrompt(ctx, sessionId, messageDbId)) return true;
  throw new Error(KEPT_MOVING);
}
