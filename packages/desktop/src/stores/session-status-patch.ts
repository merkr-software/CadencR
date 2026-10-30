import type { LiveAgentStatus, PendingKind } from "@/types/agent";
import type { SessionStatusEntry } from "./session-status-store";
import type { SessionEntry } from "./ws-session-types";
import { buildClearedGatePatch } from "./ws-gate-state";
import { isTurnInProgress, transitionTurn, type TurnLifecycle } from "./ws-turn-lifecycle";
import { anchorTurnTiming } from "./ws-turn-timing";

export type StatusSyncEntry = Pick<SessionStatusEntry, "status" | "kind" | "turnStartedAtMs">;

/** Explicit clock inputs keep status reconciliation independent of global stores. */
interface StatusSyncTime {
  serverStartedAtLocalMs: number | null;
  nowMs: number;
}

/** Clear only the gate that the app socket actually saw close. A newer gate wins. */
export function statusSyncPatch(
  session: SessionEntry,
  entry: StatusSyncEntry,
  previous: SessionStatusEntry | undefined,
  time: StatusSyncTime,
): Partial<SessionEntry> | null {
  const lifecycle = lifecycleFromStatus(session.lifecycle, entry.status, entry.kind);
  const gatePatch =
    previous?.status === "question" &&
    entry.status !== "question" &&
    (previous.requestId == null || previous.requestId === session.pendingRequestId)
      ? buildClearedGatePatch(session)
      : null;
  // updateSession handles timing transitions and turn-summary normalization.
  if (lifecycle !== session.lifecycle) return { ...gatePatch, lifecycle };
  const turnTiming = anchorTurnTiming(
    session.turnTiming,
    lifecycle,
    time.serverStartedAtLocalMs,
    time.nowMs,
  );
  if (turnTiming !== session.turnTiming) return { ...gatePatch, turnTiming };
  return gatePatch;
}

function lifecycleFromStatus(
  lifecycle: TurnLifecycle,
  status: LiveAgentStatus,
  kind: PendingKind | null,
): TurnLifecycle {
  if (status === "agent") return transitionTurn(lifecycle, { type: "stream_activity" });
  if (status === "question") {
    const reason = kind === "question" ? "question" : "permission";
    if (lifecycle.phase === "paused" && lifecycle.reason === reason) return lifecycle;
    return transitionTurn(lifecycle, {
      type: kind === "question" ? "question_requested" : "permission_requested",
    });
  }
  if (isTurnInProgress(lifecycle)) {
    return transitionTurn(lifecycle, { type: "turn_ended", reason: "completed" });
  }
  return lifecycle;
}
