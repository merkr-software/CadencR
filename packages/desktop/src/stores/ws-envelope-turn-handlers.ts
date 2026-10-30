import {
  parseEndedPayload,
  parseStreamStatusPayload,
  parseUsagePayload,
} from "./ws-envelope-payload";
import { blocksPatchWithDerived } from "./ws-message-processing";
import type { SessionEntry } from "./ws-session-types";
import { updateSession } from "./ws-session-types";
import { transitionTurn, type TurnTerminalReason } from "./ws-turn-lifecycle";
import {
  markPendingPromptsUnknown,
  markPromptsReceived,
  trimTailPromptTurnBoundary,
} from "./ws-pending-prompts";
import { repairPersistedBlocksAfterTurn } from "./ws-session-resync";
import { repairRecoveredPersistence } from "./ws-persistence-resync";
import type { StoreAccessors } from "./ws-envelope-types";
import { normalizeContextWindow, type ContextUsageState } from "@/types/agent";
import { toast } from "sonner";

/**
 * `session.stream_status` envelope handler. The backend emits this when
 * the underlying transport for an agent stream goes degraded or recovers
 * (today only OpenCode emits transitions away from `"ok"`). The shape is
 * provider-neutral. PR-A wires the store flag; PR-C will render an
 * inline "Reconnecting…" banner under the loader.
 *
 * This is the user-visible counterpart to plan finding #1: the smoking-
 * gun fix in the SDK now drops subscriber senders on reconnect, the
 * service adapter forwards lifecycle events as `RuntimeStreamStatus`,
 * and we land that here so the UI never silently freezes.
 */
export function handleStreamStatus(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const p = parseStreamStatusPayload(payload);
  if (!p) {
    // Surface malformed envelopes — see error-handling.md. Keeping this
    // a console warning (not a toast) since users can't act on it; the
    // backend is misbehaving.
    console.warn("[ws-session] dropped malformed stream_status envelope", {
      payload,
    });
    return;
  }
  const next: SessionEntry["streamHealth"] =
    p.state === "degraded"
      ? { state: "degraded", reason: p.reason, since: Date.now() }
      : { state: "ok", since: Date.now() };
  ctx.set(updateSession(ctx.get(), sessionId, { streamHealth: next }));
}

export function handleUsageUpdate(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const u = parseUsagePayload(payload);
  if (!u) return;
  const session = ctx.getSession(sessionId);
  const previous = session.contextUsage;
  // The payload is a complete snapshot, so a missing window means "unknown",
  // not "unchanged" — see SessionUsageUpdatePayload. Reusing the stored one
  // would keep scaling by a model that is no longer running.
  const next: ContextUsageState = {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    contextWindow: normalizeContextWindow(u.context_window),
    wasCompacted: previous?.wasCompacted ?? false,
  };
  // Roughly two updates per agent step land here; without this the whole
  // session entry is replaced each time and every subscriber re-renders.
  if (
    previous &&
    previous.inputTokens === next.inputTokens &&
    previous.outputTokens === next.outputTokens &&
    previous.contextWindow === next.contextWindow &&
    previous.wasCompacted === next.wasCompacted
  ) {
    return;
  }
  ctx.set(updateSession(ctx.get(), sessionId, { contextUsage: next }));
}

export function handleTurnComplete(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const session = ctx.getSession(sessionId);
  if (session.pendingPlanApproval != null) {
    return;
  }
  const ended = parseEndedPayload(payload);
  if (!ended) {
    console.warn("[ws-session] dropped malformed session.ended envelope", payload);
    toast.error(
      "The agent sent an invalid turn-complete update. The conversation was not changed.",
    );
    return;
  }
  const state = session.streamingState;
  // A dropped `content_block_stop` must not retain raw structured chunks past
  // the turn. Complete JSON has already published at its scanner boundary;
  // anything left here is malformed/incomplete and cannot become authoritative.
  state.structuredToolStreams.clear();
  // A seq gap was detected mid-turn: now that no more deltas can arrive, the
  // persisted transcript is authoritative — overwrite any truncated blocks.
  if (state.tailRepairNeeded) {
    // Clear eagerly so a second turn_complete can't race a duplicate repair,
    // but restore the flag if the refetch fails — otherwise this session would
    // never retry the repair and the truncated blocks stay lost.
    state.tailRepairNeeded = false;
    repairPersistedBlocksAfterTurn(ctx, sessionId).catch((err: unknown) => {
      state.tailRepairNeeded = true;
      console.warn("[ws-session] post-turn transcript repair failed; will retry", err);
    });
  }
  // The turn only ends once every subagent — foreground and background — has
  // finished, so mark them all complete. Iterating the block map (rather than
  // the live streams) is what makes this correct for parallel background
  // subagents: they share one per-session stream context whose `parentToolUseId`
  // only points at the last-seen agent, which would leave the others spinning.
  for (const block of state.toolUseIdToBlock.values()) {
    if (block.childBlocks && !block.taskComplete) block.taskComplete = true;
  }
  for (const stream of state.streams.values()) {
    stream.parentToolUseId = null;
  }

  const receivedBlocks = markPromptsReceived(session.blocks, ended.receivedPromptMessageUuids);
  const terminalBlocks = markPendingPromptsUnknown(receivedBlocks);
  const tailPromptBoundary = trimTailPromptTurnBoundary(terminalBlocks);
  // The backend persisted a "stopped by you" marker for this turn; show it now
  // (a reload reads the persisted row instead).
  const blocks =
    ended.reason === "turn_interrupted"
      ? [
          ...tailPromptBoundary.blocks,
          { id: `interrupted-${Date.now()}`, type: "turn_interrupted" as const, content: "" },
        ]
      : tailPromptBoundary.blocks;
  const lifecycle = transitionTurn(session.lifecycle, {
    type: "turn_ended",
    reason: mapTerminalReason(ended.reason),
  });
  const shouldClearRuntimeCompacting = session.runtimeCompacting;
  if (
    blocks === session.blocks &&
    lifecycle === session.lifecycle &&
    !shouldClearRuntimeCompacting
  ) {
    repairRecoveredPersistence(ctx, sessionId);
    return;
  }
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      ...(blocks === session.blocks ? {} : blocksPatchWithDerived(state, blocks)),
      lifecycle,
      ...(shouldClearRuntimeCompacting ? { runtimeCompacting: false } : {}),
    }),
  );
  repairRecoveredPersistence(ctx, sessionId);
}

function mapTerminalReason(reason: string | undefined): TurnTerminalReason {
  switch (reason) {
    case "provider_complete":
    case "turn_complete":
      return "completed";
    case "stream_closed":
      return "streamClosed";
    case "turn_cleared":
      return "cleared";
    case "permission_denied":
      return "denied";
    default:
      return "completed";
  }
}
