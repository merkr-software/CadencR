import { useEffect, useMemo } from "react";
import { useGetFeatureAgentState, type FeatureAgentStateResponse } from "@/api/generated";
import { serverBlocksToAgentBlocks } from "@/hooks/useFeatureAgentState";
import type { UseWebSocketSessionOptions } from "@/hooks/useWebSocketSession";
import { apiErrorMessage } from "@/lib/api-errors";
import { AGENT_STATE_INITIAL_MESSAGE_LIMIT } from "@/lib/agent-state-limits";
import { useWsSessionStore } from "@/stores/ws-session-store";
import type { PersistedStatePayload, SessionEntry } from "@/stores/ws-session-types";
import { persistedSessionToLifecycle } from "@/stores/ws-turn-lifecycle";
import { parseAccessMode } from "@/types/access-mode";
import { normalizeContextWindow, type ContextUsageState } from "@/types/agent";
import { parsePermissionMode } from "@/types/permission-mode";

type PersistedSession = FeatureAgentStateResponse["sessions"][number];

const HISTORY_FAILURE_FALLBACK = "The service didn't return this conversation's history.";

function persistedContextUsage(session: PersistedSession): ContextUsageState | null {
  const contextWindow = normalizeContextWindow(session.contextWindow);
  if (session.inputTokens <= 0 && session.outputTokens <= 0 && contextWindow == null) return null;
  return {
    inputTokens: session.inputTokens ?? 0,
    outputTokens: session.outputTokens ?? 0,
    contextWindow,
    wasCompacted: session.wasCompacted ?? false,
  };
}

function persistedStatePayload(
  session: PersistedSession,
  featureId: number,
): PersistedStatePayload {
  return {
    blocks: serverBlocksToAgentBlocks(session.blocks),
    lifecycle: persistedSessionToLifecycle(session),
    hasMore: session.hasMore,
    oldestMessageId: session.oldestMessageId,
    maxMessageId: session.maxMessageId,
    maxContentRevision: session.maxContentRevision,
    featureId,
    sessionDbId: session.sessionDbId,
    currentSelection:
      session.runtimeProvider && session.model
        ? { providerId: session.runtimeProvider, modelId: session.model }
        : undefined,
    currentProfile: session.profile ?? undefined,
    permissionMode: parsePermissionMode(session.permissionMode) ?? undefined,
    accessMode: parseAccessMode(session.accessMode),
    runtimeSessionId: session.runtimeSessionId ?? undefined,
    pendingPermission: session.pendingPermission,
    pendingQuestions: session.pendingQuestions,
    contextUsage: persistedContextUsage(session),
    hasFileChanges: session.hasFileChanges,
  };
}

/**
 * Loads the conversation's saved history once per session entry. A failed
 * fetch still settles the `persistedLoaded` gate (the auto-init effect waits on
 * it), but records why as `historyLoadFailure` so the transcript shows the
 * failure and a retry instead of reading as an empty conversation. A retry
 * re-opens the gate, which re-enables the query.
 */
export function usePersistedSessionLoader(
  session: SessionEntry | undefined,
  sessionId: string,
  featureId: number | undefined,
  options: UseWebSocketSessionOptions | undefined,
): void {
  const loadPersisted = options?.loadPersisted ?? true;
  const persistedLoaded = session?.persistedLoaded ?? false;
  const persistedStateParams = useMemo(() => ({ limit: AGENT_STATE_INITIAL_MESSAGE_LIMIT }), []);
  const agentStateQuery = useGetFeatureAgentState(featureId ?? 0, persistedStateParams, {
    query: {
      enabled: loadPersisted && !!featureId && !persistedLoaded,
      gcTime: 0,
      // One visible failure with a retry button beats a silent backoff.
      retry: false,
    },
  });
  const { data, error, isError, isFetching } = agentStateQuery;

  useEffect(() => {
    if (persistedLoaded || !featureId) return;
    const store = useWsSessionStore.getState();
    if (isError) {
      // A retry's refetch still reports the previous error until it settles.
      if (isFetching) return;
      store.failPersistedLoad(sessionId, apiErrorMessage(error, HISTORY_FAILURE_FALLBACK));
      return;
    }
    if (!data) return;
    const lastSession = data.sessions.at(-1);
    if (!lastSession) {
      store.markPersistedLoaded(sessionId);
      return;
    }
    store.setPersistedState(sessionId, persistedStatePayload(lastSession, featureId));
  }, [featureId, data, error, isError, isFetching, persistedLoaded, sessionId]);
}
