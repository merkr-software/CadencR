import type { SessionStatusEntry } from "./session-status-store";
import type { SessionEntry } from "./ws-session-types";
import { buildResolvedGatePatch, hasOpenGate } from "./ws-gate-state";
import { transitionTurn } from "./ws-turn-lifecycle";
import { reconcileTurnAnchor, transitionTurnTiming } from "./ws-turn-timing";

/** A live status confirms activity, not the resolution of an individual gate. */
export function statusSyncPatch(
  session: SessionEntry,
  entry: Pick<SessionStatusEntry, "status" | "kind" | "turnStartedAtMs" | "resolvedRequestId">,
): Partial<SessionEntry> {
  const gatePatch = entry.resolvedRequestId
    ? buildResolvedGatePatch(session, entry.resolvedRequestId)
    : {};
  const current = session.lifecycle;
  const lifecycle = hasOpenGate({ ...session, ...gatePatch })
    ? current
    : entry.status === "agent"
      ? transitionTurn(current, { type: "stream_activity" })
      : entry.status === "question"
        ? transitionTurn(current, {
            type: entry.kind === "question" ? "question_requested" : "permission_requested",
          })
        : current.phase === "active" || current.phase === "paused"
          ? transitionTurn(current, { type: "turn_ended", reason: "completed" })
          : current;
  const changed =
    current.phase !== lifecycle.phase ||
    (current.phase === "paused" &&
      lifecycle.phase === "paused" &&
      current.reason !== lifecycle.reason);
  let turnTiming = changed
    ? transitionTurnTiming(session.turnTiming, current, lifecycle)
    : session.turnTiming;
  if (entry.status !== "idle" && entry.turnStartedAtMs != null) {
    turnTiming = reconcileTurnAnchor(turnTiming, entry.turnStartedAtMs);
  }
  if (
    session.turnTiming.startedAt != null &&
    session.turnTiming.segmentStartedAt == null &&
    (current.phase === "active" || current.phase === "paused") &&
    turnTiming.serverStartedAt === session.turnTiming.serverStartedAt
  ) {
    turnTiming = { ...turnTiming, segmentStartedAt: null };
  }
  return { ...gatePatch, lifecycle, turnTiming };
}
