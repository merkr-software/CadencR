/** Lifecycle updates and summary helpers for WebSocket session state. */

import type { AgentBlockData } from "@/components/AgentBlock";
import { isCadencrPlanPresentationTool } from "@/lib/tool-call-parser";
import { blocksPatchWithDerived } from "./ws-block-mutations";
import type { SessionEntry } from "./ws-session-types";
import type { WsSessionStore } from "./ws-session-store-types";
import { createIdleTurnLifecycle, type TurnLifecycle } from "./ws-turn-lifecycle";
import { formatTurnDuration, transitionTurnTiming, type TurnTimingState } from "./ws-turn-timing";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function updateSession(
  state: Pick<WsSessionStore, "sessions">,
  sessionId: string,
  patch: Partial<SessionEntry>,
): Partial<WsSessionStore> {
  const prev = state.sessions[sessionId];
  if (!prev) return {};
  const normalizedPatch = normalizeSessionPatch(prev, patch);
  const next = { ...prev, ...normalizedPatch };
  // Recompute timing on a lifecycle change UNLESS the caller supplied its own
  // `turnTiming` (e.g. a status-driven sync anchoring the timer to the
  // server-stamped turn start) — honoring it keeps all devices in sync.
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

export function markLastPlanBlock(
  blocks: AgentBlockData[],
  status: "approved" | "rejected",
): AgentBlockData[] {
  const lastIdx = blocks.findLastIndex(
    (b) =>
      b.type === "tool_call" &&
      (b.toolName === "ExitPlanMode" || isCadencrPlanPresentationTool(b.toolName)),
  );
  if (lastIdx === -1) return blocks;
  const updated = [...blocks];
  updated[lastIdx] = { ...updated[lastIdx], planApprovalStatus: status };
  return updated;
}
