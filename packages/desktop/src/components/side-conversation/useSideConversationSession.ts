import { useEffect } from "react";
import { useWebSocketSession } from "@/hooks/useWebSocketSession";
import { wsSessionIdFromFeature } from "@/lib/ws-session-id";
import { useWsSessionStore } from "@/stores/ws-session-store";

/**
 * A side conversation's session: its persisted history and, while its agent
 * is live, its streamed turn — joined with `session.init` like the full view
 * does on mount. Joining only attaches this window as a viewer; `session.init`
 * stores the mode it is given, so it passes the persisted one — the source
 * conversation's mode, inherited when the service created it.
 */
export function useSideConversationSession(featureId: number, cwd: string, live: boolean) {
  const wsSessionId = wsSessionIdFromFeature(featureId);
  const ws = useWebSocketSession(wsSessionId, featureId);
  const persistedLoaded = useWsSessionStore(
    (state) => state.sessions[wsSessionId]?.persistedLoaded ?? false,
  );
  const joined = useWsSessionStore(
    (state) => (state.sessions[wsSessionId]?.serverSessionId ?? "") !== "",
  );
  const { initSession, isConnected, permissionMode } = ws;
  useEffect(() => {
    if (!live || !isConnected || !persistedLoaded || joined) return;
    // The full view of the same conversation may be joining it too.
    if (useWsSessionStore.getState().sessions[wsSessionId]?.initRequestId) return;
    initSession({ cwd, featureId, permissionMode });
  }, [
    cwd,
    featureId,
    initSession,
    isConnected,
    joined,
    live,
    permissionMode,
    persistedLoaded,
    wsSessionId,
  ]);
  return { ws, persistedLoaded };
}
