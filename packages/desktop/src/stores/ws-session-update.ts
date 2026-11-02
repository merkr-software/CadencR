import type { AgentBlockData } from "@/types/agent-block";
import type { SessionEntry, WsSessionStore } from "./ws-session-types";
import { clearQuestionDraft } from "./question-drafts";
import { createIdleTurnLifecycle } from "./ws-turn-lifecycle";

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
