import { useEffect } from "react";
import { useGetFeatureAgentState } from "@/api/generated";
import type { UseWebSocketSessionOptions } from "@/hooks/useWebSocketSession";
import { apiErrorMessage, toastError } from "@/lib/api-errors";
import { CONVERSATION_SNAPSHOT_PARAMS, takeSnapshotHydration } from "@/lib/conversation-preload";
import { conversationSnapshot } from "@/lib/conversation-snapshot";
import { useWsSessionStore } from "@/stores/ws-session-store";
import type { SessionEntry } from "@/stores/ws-session-types";

const HISTORY_FAILURE_FALLBACK = "The service didn't return this conversation's history.";

/**
 * Loads the conversation's saved history once per session entry. A failed
 * fetch still settles the `persistedLoaded` gate (the auto-init effect waits on
 * it), but records why as `historyLoadFailure` so the transcript shows the
 * failure and a retry instead of reading as an empty conversation. A retry
 * re-opens the gate, which re-enables the query.
 *
 * A conversation opened from a preloaded snapshot (`hydratePreloadedConversation`)
 * arrives here with the gate already settled: nothing is fetched, and the rows
 * written between that snapshot and the session going live are caught up below.
 */
export function usePersistedSessionLoader(
  session: SessionEntry | undefined,
  sessionId: string,
  featureId: number | undefined,
  options: UseWebSocketSessionOptions | undefined,
): void {
  const loadPersisted = options?.loadPersisted ?? true;
  const persistedLoaded = session?.persistedLoaded ?? false;
  const agentStateQuery = useGetFeatureAgentState(featureId ?? 0, CONVERSATION_SNAPSHOT_PARAMS, {
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
    const snapshot = conversationSnapshot(data, featureId);
    if (snapshot) store.setPersistedState(sessionId, snapshot);
    else store.markPersistedLoaded(sessionId);
  }, [featureId, data, error, isError, isFetching, persistedLoaded, sessionId]);

  useSnapshotCatchUp(sessionId, (session?.serverSessionId ?? "") !== "");
}

/**
 * A preloaded snapshot was read before this session's socket was bound: once
 * the session is live, fetch the rows persisted in between. The stream's own
 * gap detection only covers what is sent after the binding.
 */
function useSnapshotCatchUp(sessionId: string, isLive: boolean): void {
  useEffect(() => {
    if (!isLive || !takeSnapshotHydration(sessionId)) return;
    useWsSessionStore
      .getState()
      .refreshSessionMessages(sessionId)
      .catch((error: unknown) => toastError(error, "Could not refresh this conversation"));
  }, [isLive, sessionId]);
}
