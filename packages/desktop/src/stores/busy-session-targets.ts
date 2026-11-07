/**
 * Backend-reported busy sessions, resolved to the conversations this window
 * holds a socket for. Global "is an agent working?" checks (power blocker,
 * Stop all agents, OS suspend) read the status book, which covers agents
 * started by a schedule, MCP, or another device — never the local
 * `TurnLifecycle`, which only knows conversations loaded here.
 */
import type { LiveAgentStatus } from "@/types/agent";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { useWsSessionStore } from "@/stores/ws-session-store";

/** Mid-turn: the agent is working (a gate waiting on the user excluded). */
export const MID_TURN: ReadonlySet<LiveAgentStatus> = new Set(["agent"]);
/** A turn in progress, working or waiting on a gate. */
export const TURN_IN_PROGRESS: ReadonlySet<LiveAgentStatus> = new Set(["agent", "question"]);

export interface BusySessionTargets {
  /** ws-session keys of busy conversations loaded here with a live runtime. */
  loaded: string[];
  /** Busy sessions this window has no conversation socket for. */
  unreachable: number;
}

export function busySessionTargets(statuses: ReadonlySet<LiveAgentStatus>): BusySessionTargets {
  const loadedByDbId = new Map<number, string>();
  for (const [sessionId, session] of Object.entries(useWsSessionStore.getState().sessions)) {
    if (session.sessionDbId != null && session.serverSessionId) {
      loadedByDbId.set(session.sessionDbId, sessionId);
    }
  }
  const loaded: string[] = [];
  let unreachable = 0;
  for (const [id, entry] of Object.entries(useSessionStatusStore.getState().bySession)) {
    if (!statuses.has(entry.status)) continue;
    const sessionId = loadedByDbId.get(Number(id));
    if (sessionId) loaded.push(sessionId);
    else unreachable += 1;
  }
  return { loaded, unreachable };
}
