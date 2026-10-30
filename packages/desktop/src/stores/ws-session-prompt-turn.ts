import { getFeatureAgentState } from "@/api/generated";
import { serverBlocksToAgentBlocks } from "@/hooks/useFeatureAgentState";
import type { DisplayRowMode } from "@/types/agent-stream";
import type { StoreAccessors } from "./ws-envelope-handler";
import { blockMessageDbId } from "./ws-message-identity";
import { prependHistoryBlocks } from "./ws-session-prepend";

/**
 * Makes one prompt that sits in unloaded history reachable, for the message
 * navigator: fetches the prompt and the start of its turn (one forward page)
 * and merges it in by database order — the same shape as the first-prompt
 * anchor the server ships ahead of the initial window.
 *
 * Paging back to an old prompt instead would pull in every message in
 * between, and a long agentic session holds thousands per turn. The gap this
 * leaves is closed by ordinary older-history paging, which merges by identity.
 * The pagination cursor (`oldestMessageId`, `hasMore`) is left alone for
 * exactly that reason.
 *
 * Resolves with whether the prompt is now in the transcript.
 */
export async function loadSessionPromptTurn(
  ctx: StoreAccessors,
  sessionId: string,
  messageDbId: number,
  displayMode?: DisplayRowMode,
): Promise<boolean> {
  const session = ctx.get().sessions[sessionId];
  if (!session?.featureId || !session.sessionDbId) return false;
  const sessionDbId = session.sessionDbId;
  const data = await getFeatureAgentState(session.featureId, {
    // `after` is exclusive: start the forward page on the prompt itself.
    after: JSON.stringify({ [sessionDbId]: messageDbId - 1 }),
    // A revision cursor past any real one: only the forward page, not the
    // session's recently edited tool calls from elsewhere in history.
    after_revisions: JSON.stringify({ [sessionDbId]: Number.MAX_SAFE_INTEGER }),
  });
  const serverSession = data.sessions.find((s) => s.sessionDbId === sessionDbId);
  const turn = serverBlocksToAgentBlocks((serverSession?.blocks ?? []) as never[]);
  if (!turn.some((block) => blockMessageDbId(block) === messageDbId)) return false;

  // The turn lands ahead of the loaded window, like an older-history page.
  return prependHistoryBlocks(ctx, sessionId, turn, displayMode) !== null;
}
