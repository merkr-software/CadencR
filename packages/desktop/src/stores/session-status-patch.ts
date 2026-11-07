import type { LiveAgentStatus, PendingKind } from "@/types/agent";
import type { SessionStatusEntry } from "./session-status-store";
import type { SessionEntry } from "./ws-session-types";
import { buildClearedGatePatch } from "./ws-gate-state";
import { confirmedPlanPatch } from "./ws-session-plan-actions";
import { isTurnInProgress, transitionTurn, type TurnLifecycle } from "./ws-turn-lifecycle";

export type StatusSyncEntry = Pick<SessionStatusEntry, "status" | "kind">;

/** Clear only the gate that the app socket actually saw close. A newer gate wins. */
export function statusSyncPatch(
  session: SessionEntry,
  entry: StatusSyncEntry,
  previous: SessionStatusEntry | undefined,
): Partial<SessionEntry> | null {
  // A restored plan answered by prompt is confirmed by that prompt's turn starting.
  if (session.planPromptSubmission && entry.status === "agent") {
    const confirmed = confirmedPlanPatch(session, session.planPromptSubmission);
    const base = confirmed.lifecycle ?? session.lifecycle;
    return { ...confirmed, lifecycle: lifecycleFromStatus(base, entry.status, entry.kind) };
  }
  const lifecycle = lifecycleFromStatus(session.lifecycle, entry.status, entry.kind);
  const gatePatch =
    previous?.status === "question" &&
    entry.status !== "question" &&
    (previous.requestId == null || previous.requestId === session.pendingRequestId)
      ? buildClearedGatePatch(session)
      : null;
  if (lifecycle !== session.lifecycle) return { ...gatePatch, lifecycle };
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
