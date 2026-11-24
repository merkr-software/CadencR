/**
 * Stream-loss recovery. Separate persistence recovery replaces captured unsaved
 * copies only after confirmed repair and a complete, unchanged, idle snapshot.
 *   1. Orphan deltas synthesise an in-flight block; rebind restates unflushed text.
 *   2. A per-stream sequence gap triggers an immediate canonical resync and arms
 *      tailRepairNeeded.
 *   3. Reconnect, manual and gap resyncs append missed persisted rows, deduped
 *      by UUID / DB id. Live deltas can still race these reads.
 *   4. At turn completion repairPersistedBlocksAfterTurn can safely replace
 *      truncated content and graft missing children from the DB.
 *
 * Cursor note (layers 3/4): only a completed server snapshot/resync advances
 * `lastAppliedMessageId`. A later live DB id is not a safe cursor because an
 * earlier envelope may have been dropped. Resync intentionally overlaps live
 * blocks, then merges the batch by canonical UUID / DB id.
 */
import type { WsConnection } from "@/lib/ws-connection";
import { recoverConnectedHistory, withoutReconnectNotices } from "./ws-session-history-recovery";
import { getFeatureAgentState } from "@/api/generated";
import { serverBlocksToAgentBlocks } from "@/hooks/useFeatureAgentState";
import { applyToolCallUpdates } from "@/hooks/useFeatureAgentState-merge";
import type { AgentBlockData } from "@/types/agent-block";
import { blocksPatchWithDerived, type StreamingState } from "./ws-message-processing";
import { updateSession, type ResyncTarget } from "./ws-session-types";
import type { StoreAccessors } from "./ws-envelope-handler";
import { pendingPromptFetchCursor } from "./ws-pending-prompts";
import { mergeCanonicalBlocks } from "./ws-user-message-reconciliation";
import { isServiceStopMarker } from "@/lib/agent-message-origin";
import { invalidateFeatureSubagents } from "@/hooks/useFeatureSubagents";
import {
  capturePersistenceRepair,
  removeRepairedSyntheticTail,
} from "./ws-persistence-repair-plan";

const reconnectResyncs = new Map<
  string,
  { connection: WsConnection | null; dbId: number; pending: Promise<void> }
>();

/** One guarded cold repair; an active/racing turn retries at its next completion. */
export async function resyncRecoveredPersistence(
  ctx: StoreAccessors,
  sessionId: string,
): Promise<void> {
  await reconnectResyncs.get(sessionId)?.pending;
  const session = ctx.get().sessions[sessionId];
  if (session && capturePersistenceRepair(session)) {
    if (session.featureId) invalidateFeatureSubagents(session.featureId);
    await performMessageResync(ctx, sessionId, undefined, true);
  }
}

export function resyncMessagesOnReconnect(
  ctx: StoreAccessors,
  sessionId: string,
  target?: ResyncTarget,
): Promise<void> {
  if (target) {
    invalidateFeatureSubagents(target.featureId);
    return performMessageResync(ctx, sessionId, target);
  }
  const session = ctx.get().sessions[sessionId];
  if (!session?.featureId || !session.sessionDbId) return Promise.resolve();
  const { featureId, sessionDbId: dbId } = session;
  const existing = reconnectResyncs.get(sessionId);
  const connection = ctx.transport.get(sessionId)?.conn ?? null;
  if (existing?.connection === connection && existing.dbId === dbId) return existing.pending;
  // A read started on a previous socket can predate this disconnect's missed rows.
  // Finish it first so the new read uses the last confirmed cursor, even if the old read failed.
  const read = async () => {
    if ((ctx.transport.get(sessionId)?.conn ?? null) !== connection) return;
    if (ctx.get().sessions[sessionId]?.sessionDbId !== dbId) return;
    invalidateFeatureSubagents(featureId);
    const fetchHistory = () => performMessageResync(ctx, sessionId);
    if (connection?.isOpen()) {
      await recoverConnectedHistory(ctx, sessionId, connection, fetchHistory);
    } else {
      await fetchHistory();
    }
  };
  const pending = (existing ? existing.pending.then(read, read) : read()).finally(() => {
    if (reconnectResyncs.get(sessionId)?.pending === pending) reconnectResyncs.delete(sessionId);
  });
  reconnectResyncs.set(sessionId, { connection, dbId, pending });
  return pending;
}

async function performMessageResync(
  ctx: StoreAccessors,
  sessionId: string,
  target?: ResyncTarget,
  repairPersistence = false,
): Promise<void> {
  const session = ctx.get().sessions[sessionId];
  if (!session) return;
  const featureId = target?.featureId ?? session.featureId;
  const sessionDbId = target?.sessionDbId ?? session.sessionDbId;
  if (!featureId || !sessionDbId) return;
  const cursor = target?.cursor ?? session.lastAppliedMessageId ?? 0;
  const fetchCursor = target ? cursor : pendingPromptFetchCursor(session.blocks, cursor);
  const revisionCursor = session.lastAppliedContentRevision ?? 0;
  const persistenceRepair = repairPersistence ? capturePersistenceRepair(session) : null;
  const connection = !target && !repairPersistence ? ctx.transport.get(sessionId)?.conn : null;
  const pages = await drainResyncPages({
    featureId,
    sessionDbId,
    fetchCursor: persistenceRepair ? Math.min(fetchCursor, persistenceRepair.cursor) : fetchCursor,
    revisionCursor,
    fullSnapshot: !persistenceRepair && !target && fetchCursor === 0,
  });
  if (!pages) {
    if (connection?.isOpen()) throw new Error("The service could not find this session’s history.");
    return;
  }
  if (connection && pages.stalled) {
    if (!connection.isOpen()) return;
    throw new Error("The service returned an incomplete history page. Please retry.");
  }
  const current = ctx.get().sessions[sessionId];
  if (!current || (!target && current.sessionDbId !== sessionDbId)) return;
  const idPatch = current.sessionDbId === sessionDbId ? {} : { sessionDbId };
  const currentWithUpdates = applyToolCallUpdates(
    removeRepairedSyntheticTail(
      current,
      persistenceRepair,
      pages.blocks,
      pages.complete && pages.settled,
    ),
    pages.toolCallUpdates,
    pages.truncatedToolCallUpdateIds,
  );
  const incomingWithUpdates = applyToolCallUpdates(
    pages.blocks,
    pages.toolCallUpdates,
    pages.truncatedToolCallUpdateIds,
  );
  const blocks = mergeCanonicalBlocks(
    currentWithUpdates,
    incomingWithUpdates,
    current.promptReceiptsAtSubmission,
  );
  const caughtUp = connection?.isOpen() && ctx.transport.get(sessionId)?.conn === connection;
  const merged =
    caughtUp || incomingWithUpdates.some(isServiceStopMarker)
      ? withoutReconnectNotices(blocks)
      : blocks;
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      ...idPatch,
      ...(merged === current.blocks ? {} : blocksPatchWithDerived(current.streamingState, merged)),
      lastAppliedMessageId:
        target &&
        current.sessionDbId === sessionDbId &&
        cursor > (current.lastAppliedMessageId ?? 0)
          ? current.lastAppliedMessageId
          : Math.max(current.lastAppliedMessageId ?? 0, cursor, pages.messageCursor),
      lastAppliedContentRevision: Math.max(
        current.lastAppliedContentRevision ?? 0,
        pages.revisionCursor,
      ),
    }),
  );
}

interface ResyncPageRequest {
  featureId: number;
  sessionDbId: number;
  fetchCursor: number;
  revisionCursor: number;
  fullSnapshot: boolean;
}

interface DrainedResyncPages {
  blocks: AgentBlockData[];
  toolCallUpdates: Record<string, string | null>;
  truncatedToolCallUpdateIds: Set<string>;
  messageCursor: number;
  revisionCursor: number;
  complete: boolean;
  stalled: boolean;
  settled: boolean;
}

async function drainResyncPages(request: ResyncPageRequest): Promise<DrainedResyncPages | null> {
  let messageCursor = request.fetchCursor;
  let revisionCursor = request.revisionCursor;
  let blocks: AgentBlockData[] = [];
  const toolCallUpdates: Record<string, string | null> = {};
  const truncatedToolCallUpdateIds = new Set<string>();
  let firstPage = true;
  let settled = true;
  let stalled = false;
  let incremental = true;

  while (true) {
    const data =
      firstPage && request.fullSnapshot
        ? await getFeatureAgentState(request.featureId, { session: request.sessionDbId })
        : await getFeatureAgentState(request.featureId, {
            session: request.sessionDbId,
            after: JSON.stringify({ [request.sessionDbId]: messageCursor }),
            after_revisions: JSON.stringify({ [request.sessionDbId]: revisionCursor }),
          });
    const serverSession = data?.sessions?.find(
      (candidate) => candidate.sessionDbId === request.sessionDbId,
    );
    if (!serverSession) return null;
    settled &&= ["idle", "completed", "error"].includes(serverSession.status);
    incremental &&= serverSession.isIncremental === true;
    firstPage = false;

    blocks = mergeCanonicalBlocks(
      blocks,
      serverBlocksToAgentBlocks(serverSession.blocks as never[]),
      true, // Database pages are merged in submission order before applying the live policy.
    );
    const pageTruncatedIds = new Set(serverSession.truncatedToolCallUpdateIds ?? []);
    for (const [id, content] of Object.entries(serverSession.toolCallUpdates ?? {})) {
      toolCallUpdates[id] = content;
      if (pageTruncatedIds.has(id)) truncatedToolCallUpdateIds.add(id);
      else truncatedToolCallUpdateIds.delete(id);
    }

    const nextMessageCursor = Math.max(messageCursor, serverSession.maxMessageId ?? messageCursor);
    const nextRevisionCursor = Math.max(
      revisionCursor,
      serverSession.maxContentRevision ?? revisionCursor,
    );
    const continueMessages =
      serverSession.hasMoreIncrementalMessages && nextMessageCursor > messageCursor;
    const continueRevisions =
      serverSession.hasMoreContentRevisions && nextRevisionCursor > revisionCursor;
    messageCursor = nextMessageCursor;
    revisionCursor = nextRevisionCursor;
    if (!continueMessages && !continueRevisions) {
      stalled = !!(
        serverSession.hasMoreIncrementalMessages || serverSession.hasMoreContentRevisions
      );
      break;
    }
  }

  return {
    blocks,
    toolCallUpdates,
    truncatedToolCallUpdateIds,
    messageCursor,
    revisionCursor,
    complete: incremental && !stalled,
    stalled,
    settled,
  };
}

/**
 * Detect a dropped `session.message` envelope via the backend's per-stream
 * `seq` stamp. A gap means content was lost in transit — resync missed rows
 * from the DB now, and mark the stream for a tail repair at turn end (a
 * truncated in-flight block can't be rewritten while deltas still race in).
 * A seq lower than expected is a stream-reader restart, not a gap.
 */
export function trackStreamSeq(
  ctx: StoreAccessors,
  sessionId: string,
  state: StreamingState,
  seq: number | null,
): void {
  if (seq == null) return;
  const last = state.lastMessageSeq;
  state.lastMessageSeq = seq;
  if (last == null || seq <= last + 1) return;
  console.warn("[ws-session] stream envelope gap detected; resyncing", {
    expected: last + 1,
    received: seq,
  });
  state.tailRepairNeeded = true;
  resyncMessagesOnReconnect(ctx, sessionId).catch((err: unknown) => {
    console.warn("[ws-session] gap resync failed; tail repair will retry at turn end", err);
  });
}

/**
 * Post-turn repair for a stream that dropped envelopes mid-turn (detected via
 * the `seq` gap). The reconnect resync above only *appends* missed rows — a
 * block we already hold whose deltas were lost stays truncated because its id
 * is deduped. Once the turn has ended (no more in-flight deltas to race), the
 * DB is the authoritative transcript: refetch it and overwrite any held block
 * whose persisted content is longer than what we rendered.
 */
export async function repairPersistedBlocksAfterTurn(
  ctx: StoreAccessors,
  sessionId: string,
): Promise<void> {
  const session = ctx.get().sessions[sessionId];
  if (!session?.featureId || !session.sessionDbId) return;

  const data = await getFeatureAgentState(session.featureId, { session: session.sessionDbId });
  const serverSession = data.sessions.find((s) => s.sessionDbId === session.sessionDbId);
  if (!serverSession) return;

  const fetched = serverBlocksToAgentBlocks(serverSession.blocks as never[]);
  const current = ctx.get().sessions[sessionId];
  if (!current) return;

  const serverById = new Map<string, AgentBlockData>();
  collectBlockTree(fetched, serverById);

  let changed = false;
  const markChanged = () => {
    changed = true;
  };
  const repaired = current.blocks.map((block) => repairBlockTree(block, serverById, markChanged));

  const merged = mergeCanonicalBlocks(repaired, fetched, current.promptReceiptsAtSubmission);
  const appended = merged.length - repaired.length;

  if (!changed && appended === 0 && merged === repaired) return;
  console.warn("[ws-session] repaired stream-truncated blocks from persisted transcript", {
    replaced: changed,
    appended,
  });
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      ...blocksPatchWithDerived(current.streamingState, merged),
      lastAppliedMessageId: Math.max(
        current.lastAppliedMessageId ?? 0,
        serverSession.maxMessageId ?? 0,
      ),
      lastAppliedContentRevision: Math.max(
        current.lastAppliedContentRevision ?? 0,
        serverSession.maxContentRevision ?? 0,
      ),
    }),
  );
}

function collectBlockTree(blocks: AgentBlockData[], into: Map<string, AgentBlockData>): void {
  for (const block of blocks) {
    into.set(block.id, block);
    if (block.childBlocks?.length) collectBlockTree(block.childBlocks, into);
  }
}

/**
 * Overwrite a held block's content with the persisted version when the DB has
 * strictly more of it. This runs at turn end, once the backend has written
 * every delta: it forwards text/thinking deltas before writing them (they are
 * buffered for up to one flush window), so mid-turn the DB can be *behind*
 * what was streamed, but by turn end a lost delta can only leave the client
 * behind the DB. A viewer attaching mid-stream is caught up separately, by the
 * reader's `content_block_snapshot` (`ws-message-processing-stream.ts`), since
 * its history snapshot may lack text already streamed. Recurses into children and
 * grafts on any server children that never arrived (a lost `content_block_start`
 * under a task/tool parent), so a whole subtree isn't left missing. Returns the
 * original reference when nothing changed so React sees no-ops.
 */
function repairBlockTree(
  block: AgentBlockData,
  serverById: Map<string, AgentBlockData>,
  markChanged: () => void,
): AgentBlockData {
  let next = block;

  const server = serverById.get(block.id);
  if (server && server.content !== block.content && server.content.length > block.content.length) {
    next = { ...block, content: server.content, toolArgs: server.toolArgs ?? block.toolArgs };
    markChanged();
  }

  const heldChildren = block.childBlocks ?? [];
  const serverChildren = server?.childBlocks ?? [];
  // Leaf on both sides: nothing to repair or graft — skip all per-node work.
  if (heldChildren.length === 0 && serverChildren.length === 0) return next;

  // Rebuild children in the authoritative server order, preferring the repaired
  // held version, and grafting any server children we never received (a lost
  // `content_block_start` under a task/tool parent). Server order is display
  // order, so appending missing children at the end would misplace one that was
  // lost from the middle. Held-only children (not yet on the server) trail.
  const repairedById = new Map(
    heldChildren.map((child) => [child.id, repairBlockTree(child, serverById, markChanged)]),
  );
  const serverIds = new Set(serverChildren.map((child) => child.id));
  const mergedChildren = [
    ...serverChildren.map((child) => repairedById.get(child.id) ?? child),
    ...heldChildren
      .filter((child) => !serverIds.has(child.id))
      .map((child) => repairedById.get(child.id) ?? child),
  ];

  const childrenChanged =
    mergedChildren.length !== heldChildren.length ||
    mergedChildren.some((child, i) => child !== heldChildren[i]);
  if (childrenChanged) {
    markChanged();
    next = { ...next, childBlocks: mergedChildren };
  }

  return next;
}
