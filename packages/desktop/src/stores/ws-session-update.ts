import type { AgentBlockData } from "@/types/agent-block";
import type { SessionEntry, WsSessionStore } from "./ws-session-types";
import { clearQuestionDraft } from "./question-drafts";
import { createIdleTurnLifecycle, type TurnLifecycle } from "./ws-turn-lifecycle";
import {
  anchorTurnTiming,
  formatTurnDuration,
  transitionTurnTiming,
  type TurnTimingState,
} from "./ws-turn-timing";
import { serverTurnStartLocalMs } from "./server-turn-start";
import { blocksPatchWithDerived } from "./ws-block-mutations";

export function updateSession(
  state: Pick<WsSessionStore, "sessions">,
  sessionId: string,
  patch: Partial<SessionEntry>,
): Partial<WsSessionStore> {
  const prev = state.sessions[sessionId];
  if (!prev) return {};
  const normalizedPatch = normalizeSessionPatch(prev, patch);
  const next = { ...prev, ...normalizedPatch };
  if (
    prev.sessionDbId != null &&
    prev.pendingQuestions.length > 0 &&
    (next.pendingRequestId !== prev.pendingRequestId || next.pendingQuestions.length === 0)
  ) {
    clearQuestionDraft(prev.sessionDbId, prev.pendingRequestId);
  }
  // Recompute timing on a lifecycle change unless the caller supplied its own.
  if (
    normalizedPatch.lifecycle &&
    normalizedPatch.turnTiming === undefined &&
    lifecycleChanged(prev.lifecycle, normalizedPatch.lifecycle)
  ) {
    next.turnTiming = transitionTurnTiming(
      prev.turnTiming,
      prev.lifecycle,
      normalizedPatch.lifecycle,
    );
  }
  // Every session's timer runs from the server-stamped turn start, the one
  // value all devices share.
  next.turnTiming = anchorTurnTiming(
    next.turnTiming,
    next.lifecycle,
    serverTurnStartLocalMs(next.sessionDbId),
  );
  if (shouldAppendTurnSummary(prev.lifecycle, next.lifecycle, next.turnTiming, next.blocks)) {
    const blocks = [...next.blocks, buildTurnSummaryBlock(next.turnTiming)];
    Object.assign(next, blocksPatchWithDerived(next.streamingState, blocks));
  }
  return {
    sessions: {
      ...state.sessions,
      [sessionId]: next,
    },
  };
}

function normalizeSessionPatch(
  prev: SessionEntry,
  patch: Partial<SessionEntry>,
): Partial<SessionEntry> {
  if (
    patch.lifecycle?.phase === "terminal" &&
    patch.lifecycle.reason === "completed" &&
    isEmptyUserPausedSettlement(prev, patch.blocks ?? prev.blocks)
  ) {
    return { ...patch, lifecycle: createIdleTurnLifecycle() };
  }
  return patch;
}

function isEmptyUserPausedSettlement(session: SessionEntry, blocks: AgentBlockData[]): boolean {
  return (
    session.lifecycle.phase === "paused" &&
    session.lifecycle.reason === "user" &&
    blocks.length === 0
  );
}

function lifecycleChanged(previous: TurnLifecycle, next: TurnLifecycle): boolean {
  if (previous.phase !== next.phase) return true;
  if (previous.phase === "paused" && next.phase === "paused")
    return previous.reason !== next.reason;
  if (previous.phase === "terminal" && next.phase === "terminal") {
    return previous.reason !== next.reason;
  }
  if (previous.phase === "error" && next.phase === "error")
    return previous.message !== next.message;
  return false;
}

function shouldAppendTurnSummary(
  previous: TurnLifecycle,
  next: TurnLifecycle,
  timing: TurnTimingState,
  blocks: AgentBlockData[],
): boolean {
  return (
    previous.phase !== "terminal" &&
    next.phase === "terminal" &&
    timing.completed != null &&
    blocks.at(-1)?.type !== "turn_summary"
  );
}

function buildTurnSummaryBlock(timing: TurnTimingState): AgentBlockData {
  const completed = timing.completed ?? {
    totalMs: 0,
    activeMs: 0,
    userPendingMs: 0,
  };
  const content = [
    `Worked - ${formatTurnDuration(completed.totalMs)}`,
    `Agent ${formatTurnDuration(completed.activeMs)}`,
    `Waiting ${formatTurnDuration(completed.userPendingMs)}`,
  ].join(" · ");
  return {
    id: `turn-summary-${Date.now()}`,
    type: "turn_summary",
    content,
    isError: false,
    createdAt: new Date().toISOString(),
  };
}
