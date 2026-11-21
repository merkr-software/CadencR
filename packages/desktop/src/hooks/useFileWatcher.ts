import { useEffect } from "react";
import { useWorkspaceActivity, whileActive } from "@/components/workspace-pool/workspace-activity";
import { useSessionStatusStore } from "@/stores/session-status-store";

/**
 * Subscribes to file-system change events for a project directory.
 * Sends a subscribe message via the app-level WebSocket — the same
 * connection that the session-status store maintains, so we don't open
 * a second socket per app.
 *
 * The service keeps one file-watcher subscription per client, and each
 * subscribe replaces the last one. In a conversation workspace kept mounted
 * but hidden (`WorkspacePool`) the editor must not take it from the one on
 * screen: it subscribes while its workspace is shown, again each time it is
 * shown.
 */
export function useFileWatcher(projectId: number, featureId?: number): void {
  const isConnected = useSessionStatusStore((s) => s.isConnected);
  const connectionEpoch = useSessionStatusStore((s) => s.connectionEpoch);
  const subscribeFileWatcher = useSessionStatusStore((s) => s.subscribeFileWatcher);
  const activity = useWorkspaceActivity();

  useEffect(() => {
    if (!isConnected) return undefined;
    // Nothing to stop: the subscription lasts until another one replaces it.
    return whileActive(activity, () => {
      subscribeFileWatcher(projectId, featureId);
      return () => {};
    });
  }, [activity, isConnected, connectionEpoch, subscribeFileWatcher, projectId, featureId]);
}
