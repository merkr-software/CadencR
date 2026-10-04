import type { SessionState } from "@/api/generated";

/**
 * DB-side `agent_sessions.status` column value (6-value legacy enum).
 * Not exposed on the canonical `AgentStatus` wire format any more — this
 * type is local to the lifecycle reconstruction so the frontend can still
 * resume a session from a persisted row over REST.
 */
type DbSessionStatus = "idle" | "running" | "completed" | "error" | "paused" | "waiting";
type PersistedLifecycleSession = Pick<
  SessionState,
  "status" | "blocks" | "runtimeSessionId" | "pendingPermission" | "pendingQuestions"
>;
interface PersistedLifecycleOptions {
  runningStatus?: "idle" | "active";
}

export type TurnPauseReason =
  | "permission"
  | "question"
  | "planApproval"
  | "user"
  /** OS reported a pending suspend; the agent was interrupted while the
   *  system was about to sleep. Cleared on `stream_activity` or when the
   *  user starts the next turn. See `usePowerEvents`. */
  | "suspended";
export type TurnTerminalReason = "completed" | "denied" | "cleared" | "streamClosed";

export type TurnLifecycle =
  | { phase: "idle" }
  | { phase: "active" }
  | { phase: "paused"; reason: TurnPauseReason }
  | { phase: "terminal"; reason: TurnTerminalReason }
  | { phase: "error"; message?: string };

export type TurnEvent =
  | { type: "prompt_sent" }
  | { type: "initialized" }
  | { type: "permission_requested" }
  | { type: "question_requested" }
  | { type: "plan_approval_requested" }
  | { type: "question_answered" }
  | { type: "plan_approved" }
  | { type: "plan_changes_requested" }
  | { type: "turn_ended"; reason: TurnTerminalReason }
  | { type: "turn_cleared" }
  | { type: "turn_errored"; message?: string }
  | { type: "connection_lost" }
  | { type: "stream_activity" }
  /** Backend-confirmed `session.lifecycle suspend_requested` — flips the
   *  turn into the OS-suspend paused state. Emitted only after the WS
   *  handler has captured the resume id and interrupted the runtime. */
  | { type: "suspended" }
  /** Backend-confirmed `session.lifecycle resumed`. Treated like
   *  `stream_activity`: clears the suspended banner if nothing else has
   *  moved the lifecycle in the meantime. */
  | { type: "resumed" };

export function createIdleTurnLifecycle(): TurnLifecycle {
  return { phase: "idle" };
}

export function transitionTurn(current: TurnLifecycle, event: TurnEvent): TurnLifecycle {
  switch (event.type) {
    case "prompt_sent":
      return { phase: "active" };
    case "initialized":
      return current;
    case "permission_requested":
      return { phase: "paused", reason: "permission" };
    case "question_requested":
      return { phase: "paused", reason: "question" };
    case "plan_approval_requested":
      return { phase: "paused", reason: "planApproval" };
    case "question_answered":
      return current.phase === "terminal" ? current : { phase: "active" };
    case "plan_approved":
    case "plan_changes_requested":
      return current.phase === "terminal" ? current : { phase: "active" };
    case "turn_ended":
      return current.phase === "terminal" ? current : { phase: "terminal", reason: event.reason };
    case "turn_cleared":
      return { phase: "idle" };
    case "turn_errored":
      return { phase: "error", ...(event.message ? { message: event.message } : {}) };
    case "connection_lost":
      return current;
    case "stream_activity":
      return current.phase === "active" ? current : { phase: "active" };
    case "suspended":
      // Don't override a terminal or error state — those are end-of-turn
      // outcomes the user should still see. Otherwise flip to the paused/
      // suspended banner regardless of whether the turn was active.
      if (current.phase === "terminal" || current.phase === "error") return current;
      return { phase: "paused", reason: "suspended" };
    case "resumed":
      // Only clear the suspended banner; leave any other paused/terminal
      // state alone. If the runtime is back streaming, `stream_activity`
      // arrives separately and flips us to "active".
      if (current.phase === "paused" && current.reason === "suspended") {
        return { phase: "idle" };
      }
      return current;
  }
}

export function persistedStatusToLifecycle(
  status: DbSessionStatus | string,
  options?: PersistedLifecycleOptions,
): TurnLifecycle {
  switch (status) {
    case "running":
      return options?.runningStatus === "active" ? { phase: "active" } : { phase: "idle" };
    case "paused":
    case "waiting":
      return { phase: "paused", reason: "user" };
    case "completed":
      return { phase: "terminal", reason: "completed" };
    case "error":
      return { phase: "error" };
    default:
      return { phase: "idle" };
  }
}

export function persistedSessionToLifecycle(
  session: PersistedLifecycleSession,
  options?: PersistedLifecycleOptions,
): TurnLifecycle {
  if (hasPendingSnapshotValue(session.pendingQuestions)) {
    return { phase: "paused", reason: "question" };
  }
  if (hasPendingSnapshotValue(session.pendingPermission)) {
    return { phase: "paused", reason: "permission" };
  }
  if (isEmptyPrePromptPausedSession(session)) {
    return createIdleTurnLifecycle();
  }
  return persistedStatusToLifecycle(session.status, options);
}

function isEmptyPrePromptPausedSession(session: PersistedLifecycleSession): boolean {
  if (session.status !== "paused" && session.status !== "waiting") return false;
  if (session.blocks.length > 0) return false;
  return !session.runtimeSessionId;
}

function hasPendingSnapshotValue(value: unknown): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

export function isTurnActive(lifecycle: TurnLifecycle): boolean {
  return lifecycle.phase === "active";
}
