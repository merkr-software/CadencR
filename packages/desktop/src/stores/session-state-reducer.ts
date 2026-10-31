/**
 * Pure core of the desktop's session state (docs/adr/0002): how one open
 * conversation's entry moves under a patch or a live status. The clock and the
 * server turn start come in through `SessionReducerEnv`, and side effects come
 * out as data for the caller to run, so every rule here is testable without a
 * store, a socket or a timer. One exception, by design: appending the turn
 * summary updates the incremental stream index (`streamingState`) in place,
 * as every block write does (see `blocksPatchWithDerived`).
 */
import type { AgentBlockData } from "@/components/AgentBlock";
import type { LiveAgentStatus, PendingKind } from "@/types/agent";
import type { SessionEntry } from "./ws-session-types";
import { buildClearedGatePatch } from "./ws-gate-state";
import { blocksPatchWithDerived } from "./ws-block-mutations";
import {
  createIdleTurnLifecycle,
  isTurnInProgress,
  transitionTurn,
  type TurnLifecycle,
} from "./ws-turn-lifecycle";
import {
  anchorTurnTiming,
  formatTurnDuration,
  transitionTurnTiming,
  type TurnTimingState,
} from "./ws-turn-timing";

export interface SessionReducerEnv {
  nowMs: number;
  /** Server-stamped start of a session's running turn, on this device's clock. */
  turnStartLocalMs: (sessionDbId: number | null) => number | null;
}

export type SessionEffect = {
  type: "clear_question_draft";
  sessionDbId: number;
  requestId: string;
};

export interface SessionReduction {
  next: SessionEntry;
  effects: SessionEffect[];
}

/** The live status of a session, as the app socket reports it. */
export interface LiveStatusChange {
  status: LiveAgentStatus;
  kind: PendingKind | null;
}

/** The live status this device held before the change. */
export interface PreviousLiveStatus {
  status: LiveAgentStatus;
  requestId?: string | null;
}

/**
 * Apply a patch to a session entry: recompute the turn timer on a lifecycle
 * change, anchor it to the server turn start, append the turn summary when the
 * turn ends, and ask for the question draft to be dropped when its question
 * leaves.
 */
export function reduceSessionPatch(
  prev: SessionEntry,
  patch: Partial<SessionEntry>,
  env: SessionReducerEnv,
): SessionReduction {
  const normalizedPatch = normalizeSessionPatch(prev, patch);
  const next = { ...prev, ...normalizedPatch };
  const effects: SessionEffect[] = [];
  if (
    prev.sessionDbId != null &&
    prev.pendingQuestions.length > 0 &&
    (next.pendingRequestId !== prev.pendingRequestId || next.pendingQuestions.length === 0)
  ) {
    effects.push({
      type: "clear_question_draft",
      sessionDbId: prev.sessionDbId,
      requestId: prev.pendingRequestId,
    });
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
      env.nowMs,
    );
  }
  // Every session's timer runs from the server-stamped turn start, the one
  // value all devices share.
  next.turnTiming = anchorTurnTiming(
    next.turnTiming,
    next.lifecycle,
    env.turnStartLocalMs(next.sessionDbId),
    env.nowMs,
  );
  if (shouldAppendTurnSummary(prev.lifecycle, next.lifecycle, next.turnTiming, next.blocks)) {
    const blocks = [...next.blocks, buildTurnSummaryBlock(next.turnTiming, env.nowMs)];
    Object.assign(next, blocksPatchWithDerived(next.streamingState, blocks));
  }
  return { next, effects };
}

/**
 * The patch a live status change makes to an open conversation: its turn
 * lifecycle, and a gate clear when the session leaves the "question" state.
 *
 * A gate (permission/plan/question) is answered on whichever device the user
 * is holding; the backend then broadcasts the session out of "question" to
 * every client. Clearing the gate here makes it disappear on the *other*
 * devices too (the answering device already cleared its own). Keyed on the
 * app socket's own prev→next transition, so it never races a freshly arrived
 * gate on the feature socket.
 */
export function liveStatusPatch(
  session: SessionEntry,
  change: LiveStatusChange,
  previous: PreviousLiveStatus | undefined,
  env: SessionReducerEnv,
): Partial<SessionEntry> | null {
  const lifecyclePatch = lifecyclePatchFromStatus(session, change, env);
  const gatePatch =
    previous?.status === "question" &&
    change.status !== "question" &&
    (previous.requestId == null || previous.requestId === session.pendingRequestId)
      ? buildClearedGatePatch(session)
      : null;
  if (!lifecyclePatch && !gatePatch) return null;
  return { ...gatePatch, ...lifecyclePatch };
}

function lifecyclePatchFromStatus(
  session: SessionEntry,
  change: LiveStatusChange,
  env: SessionReducerEnv,
): Pick<SessionEntry, "lifecycle"> | Pick<SessionEntry, "lifecycle" | "turnTiming"> | null {
  const lifecycle = lifecycleFromStatus(session.lifecycle, change.status, change.kind);
  if (lifecycle !== session.lifecycle) return { lifecycle };
  // Same lifecycle, but this device first saw the turn through its own stream
  // (or the turn restarted): move its timer to the server start.
  const turnTiming = anchorTurnTiming(
    session.turnTiming,
    lifecycle,
    env.turnStartLocalMs(session.sessionDbId),
    env.nowMs,
  );
  return turnTiming === session.turnTiming ? null : { lifecycle, turnTiming };
}

function lifecycleFromStatus(
  lifecycle: TurnLifecycle,
  status: LiveAgentStatus,
  kind: PendingKind | null,
): TurnLifecycle {
  if (status === "agent") return transitionTurn(lifecycle, { type: "stream_activity" });
  if (status === "question") {
    return transitionTurn(lifecycle, {
      type: kind === "question" ? "question_requested" : "permission_requested",
    });
  }
  if (status === "idle" && isTurnInProgress(lifecycle)) {
    return transitionTurn(lifecycle, { type: "turn_ended", reason: "completed" });
  }
  return lifecycle;
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

function buildTurnSummaryBlock(timing: TurnTimingState, nowMs: number): AgentBlockData {
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
    id: `turn-summary-${nowMs}`,
    type: "turn_summary",
    content,
    isError: false,
    createdAt: new Date(nowMs).toISOString(),
  };
}
