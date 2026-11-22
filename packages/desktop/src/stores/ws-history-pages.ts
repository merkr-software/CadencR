import { getFeatureAgentState } from "@/api/generated";
import { serverBlocksToAgentBlocks } from "@/hooks/useFeatureAgentState";
import { AGENT_STATE_OLDER_MESSAGE_LIMIT } from "@/lib/agent-state-limits";
import type { AgentBlockData } from "@/types/agent-block";

const MISSING_SESSION = "The service didn't return this conversation's history.";

/**
 * A page of a session's saved history. Pages are kept inside the gap they
 * fill (`since` / `until`): the server joins consecutive text rows into one
 * block per page, so a page running into rows already loaded would repeat
 * their text under another block id.
 */
export interface HistoryPage {
  blocks: AgentBlockData[];
  /** Every message with `from <= id <= to` is now known (open bounds: to the session's edge). */
  from: number;
  to: number;
}

/**
 * The page just above `beforeId` (`before` paging), newest first, stopping
 * after `sinceId` (exclusive) when the gap has loaded rows above it.
 */
export async function fetchOlderPage(
  featureId: number,
  sessionDbId: number,
  beforeId: number,
  sinceId: number | null,
): Promise<HistoryPage> {
  const data = await getFeatureAgentState(featureId, {
    before: JSON.stringify({ [sessionDbId]: beforeId }),
    limit: AGENT_STATE_OLDER_MESSAGE_LIMIT,
    ...(sinceId === null ? {} : { since: JSON.stringify({ [sessionDbId]: sinceId }) }),
  });
  const session = data.sessions.find((s) => s.sessionDbId === sessionDbId);
  if (!session) throw new Error(MISSING_SESSION);
  const oldest = session.oldestMessageId ?? null;
  // No more rows in the bounded range: all of it came back.
  const exhausted = sinceId === null ? -Infinity : sinceId + 1;
  return {
    blocks: serverBlocksToAgentBlocks(session.blocks as never[]),
    from: session.hasMore && oldest !== null ? oldest : exhausted,
    to: beforeId - 1,
  };
}

/**
 * The page just below `afterId` (`after` paging), oldest first, stopping
 * before `untilId` (exclusive) when the gap has loaded rows below it.
 */
export async function fetchNewerPage(
  featureId: number,
  sessionDbId: number,
  afterId: number,
  untilId: number | null,
): Promise<HistoryPage> {
  const data = await getFeatureAgentState(featureId, {
    after: JSON.stringify({ [sessionDbId]: afterId }),
    // A revision cursor past any real one: only the forward page, not the
    // session's recently edited tool calls from elsewhere in history.
    after_revisions: JSON.stringify({ [sessionDbId]: Number.MAX_SAFE_INTEGER }),
    ...(untilId === null ? {} : { until: JSON.stringify({ [sessionDbId]: untilId }) }),
  });
  const session = data.sessions.find((s) => s.sessionDbId === sessionDbId);
  if (!session) throw new Error(MISSING_SESSION);
  const exhausted = untilId === null ? Infinity : untilId - 1;
  return {
    blocks: serverBlocksToAgentBlocks(session.blocks as never[]),
    from: afterId + 1,
    to: session.hasMoreIncrementalMessages ? session.maxMessageId : exhausted,
  };
}
