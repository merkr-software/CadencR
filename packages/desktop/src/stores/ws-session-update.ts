import type { SessionEntry, WsSessionStore } from "./ws-session-types";
import { clearQuestionDraft } from "./question-drafts";
import { serverTurnStartLocalMs } from "./server-turn-start";
import {
  reduceSessionPatch,
  type SessionEffect,
  type SessionReducerEnv,
} from "./session-state-reducer";

export function updateSession(
  state: Pick<WsSessionStore, "sessions">,
  sessionId: string,
  patch: Partial<SessionEntry>,
): Partial<WsSessionStore> {
  const prev = state.sessions[sessionId];
  if (!prev) return {};
  const { next, effects } = reduceSessionPatch(prev, patch, liveSessionEnv());
  runSessionEffects(effects);
  return {
    sessions: {
      ...state.sessions,
      [sessionId]: next,
    },
  };
}

/** The real clock and the server turn starts held by the live status. */
export function liveSessionEnv(): SessionReducerEnv {
  return { nowMs: Date.now(), turnStartLocalMs: serverTurnStartLocalMs };
}

function runSessionEffects(effects: SessionEffect[]): void {
  for (const effect of effects) clearQuestionDraft(effect.sessionDbId, effect.requestId);
}
