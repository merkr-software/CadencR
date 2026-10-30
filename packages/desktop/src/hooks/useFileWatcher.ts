import { useEffect } from "react";
import { useSessionStatusStore } from "@/stores/session-status-store";

/**
 * Subscribes to file-system change events for a project directory.
 * Sends a subscribe message via the app-level WebSocket — the same
 * connection that the session-status store maintains, so we don't open
 * a second socket per app.
 */
export function useFileWatcher(projectId: number, featureId?: number): void {
  const isConnected = useSessionStatusStore((s) => s.isConnected);
  const connectionEpoch = useSessionStatusStore((s) => s.connectionEpoch);
  const subscribeFileWatcher = useSessionStatusStore((s) => s.subscribeFileWatcher);

  useEffect(() => {
    if (!isConnected) return;
    subscribeFileWatcher(projectId, featureId);
  }, [isConnected, connectionEpoch, subscribeFileWatcher, projectId, featureId]);
}
