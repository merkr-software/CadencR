import type { StoreApi } from "zustand";
import { toast } from "sonner";
import { createEnvelope, parseEnvelope } from "@/lib/ws-envelope";
import { getWsProtocols, getWsUrl } from "@/lib/ws-url";
import type { WsConnection } from "@/lib/ws-connection";
import { openLifecycleSocket, registerSocketRetry, retireSocket } from "@/lib/ws-lifecycle";
import { isBrowserRemote } from "@/lib/remote/device-token";
import { hydratePrStatuses } from "@/stores/pr-status-hydration";
import { subscribeForgeStatus } from "@/stores/forge-visibility";
import { clearStorageMaintenanceStatus } from "@/stores/storage-maintenance-store";
import { resetServerClock } from "@/lib/server-clock";
import { invalidateByUrlPrefix, queryClient } from "@/lib/queryClient";
import type { EnvelopeDispatcher, SessionStatusState } from "@/stores/session-status-store";

const APP_WS_SOURCE = "app-ws";

type SessionStatusSet = StoreApi<SessionStatusState>["setState"];
type SessionStatusGet = StoreApi<SessionStatusState>["getState"];
interface AppWsConnection {
  ws: WsConnection;
  set: SessionStatusSet;
  dispatchEnvelope: EnvelopeDispatcher;
  isCurrent: () => boolean;
  unsubscribeForgeVisibility: () => void;
}

function sendAppEnvelope(ws: WsConnection, action: string, payload: object = {}): void {
  ws.sendJson(createEnvelope("app", action, payload));
}

function markAppWsConnected({ set }: AppWsConnection): void {
  resetServerClock();
  set((state) => ({ isConnected: true, connectionEpoch: state.connectionEpoch + 1 }));
}

/** The service forgets a socket's subscriptions with it: every open re-sends them. */
function replayAppSubscriptions(connection: AppWsConnection): void {
  const { ws } = connection;
  sendAppEnvelope(ws, "subscribe.session_status");
  sendAppEnvelope(ws, "subscribe.feature_events");
  // An agent's project_archive_session: the Archive dialog's toast and teardown.
  sendAppEnvelope(ws, "subscribe.agent_archived_events");
  // Every archive and each of its cleanup steps, whoever made it: the local
  // teardown and the cleanup this client shows.
  sendAppEnvelope(ws, "subscribe.archive_cleanup_events");
  // A schedule fires on the server's clock, into a conversation this client
  // need not have open, so nothing else tells the sidebar its rules moved.
  sendAppEnvelope(ws, "subscribe.schedule_events");
  sendAppEnvelope(ws, "subscribe.settings_events");
  sendAppEnvelope(ws, "subscribe.theme_events");
  // Custom tab folders changed on disk: refetch the list, reload live tabs.
  sendAppEnvelope(ws, "subscribe.plugin_tab_events");
  // Prompts queued for after a turn: delivery happens server-side at turn end.
  sendAppEnvelope(ws, "subscribe.prompt_queue_events");
  sendAppEnvelope(ws, "subscribe.custom_action_events");
  sendAppEnvelope(ws, "subscribe.alacritty_config_events");
  sendAppEnvelope(ws, "subscribe.storage_maintenance_events");
  // Which agents the last restart interrupted, and which were resumed.
  sendAppEnvelope(ws, "subscribe.restart_continuation_events");
  connection.unsubscribeForgeVisibility = subscribeForgeStatus(ws);
  if (!isBrowserRemote()) {
    sendAppEnvelope(ws, "subscribe.remote_events");
    // Version checks and update outcomes toast on the host only: updates run
    // on this machine. The subscription starts with the current status list.
    sendAppEnvelope(ws, "subscribe.provider_update_events");
  }
}

/**
 * What a disconnect missed. The session-status snapshot answers the replayed
 * subscription; `connectionEpoch` (bumped on connect) tells the rest to refetch.
 */
function resyncAppState(): void {
  void invalidateByUrlPrefix(queryClient, "/api/archive-cleanups");
  void hydratePrStatuses();
}

function handleAppWsMessage(connection: AppWsConnection, data: string): void {
  let envelope: ReturnType<typeof parseEnvelope>;
  try {
    envelope = parseEnvelope(data);
  } catch {
    return;
  }
  try {
    connection.dispatchEnvelope(
      envelope.domain,
      envelope.action,
      envelope.payload as Record<string, unknown>,
    );
  } catch (error) {
    console.error("[session-status] dispatchEnvelope error:", error);
    toast.error("Background update failed", {
      id: "app-socket-dispatch-error",
      description: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The socket and its cleanup belong to this controller, never observable UI state. */
export function createAppWsConnection(
  set: SessionStatusSet,
  get: SessionStatusGet,
  dispatchEnvelope: EnvelopeDispatcher,
): Pick<
  SessionStatusState,
  "connect" | "disconnect" | "subscribeFileWatcher" | "subscribeGitStatus"
> {
  let current: AppWsConnection | null = null;
  /** Releases what the connection holds; the caller decides whether it closes. */
  const release = (connection: AppWsConnection): void => {
    connection.unsubscribeForgeVisibility();
    clearStorageMaintenanceStatus();
  };
  const retireCurrent = (): void => {
    const previous = current;
    current = null;
    if (!previous) return;
    release(previous);
    previous.ws.close();
  };
  /** Runs `step` on the current connection: the lifecycle only calls back for it. */
  const withCurrent = (step: (connection: AppWsConnection) => void) => (): void => {
    if (current) step(current);
  };
  const open = (): WsConnection =>
    openLifecycleSocket({
      key: APP_WS_SOURCE,
      url: getWsUrl(),
      protocols: getWsProtocols(),
      statusLabel: "App WebSocket",
      isCurrent: (ws) => current?.ws === ws,
      onConnected: withCurrent(markAppWsConnected),
      replay: withCurrent(replayAppSubscriptions),
      resync: resyncAppState,
      onMessage: (data) => {
        if (current) handleAppWsMessage(current, data);
      },
      onDrop: () => {
        const dropped = current;
        current = null;
        if (dropped) release(dropped);
        set({ isConnected: false });
      },
      reconnect: () => get().connect(),
    });
  const connect = (): void => {
    registerSocketRetry(APP_WS_SOURCE, () => {
      retireCurrent();
      set({ isConnected: false });
      get().connect();
    });
    if (current && (current.ws.isOpen() || current.ws.isConnecting())) return;
    retireCurrent();
    const connection: AppWsConnection = {
      ws: open(),
      set,
      dispatchEnvelope,
      isCurrent: () => current === connection,
      unsubscribeForgeVisibility: () => {},
    };
    current = connection;
  };
  return {
    connect,
    disconnect() {
      retireSocket(APP_WS_SOURCE);
      retireCurrent();
      set({ isConnected: false });
    },
    subscribeFileWatcher(projectId, featureId) {
      const connection = current;
      if (!connection?.ws.isOpen()) return;
      sendAppEnvelope(connection.ws, "subscribe.file_watcher", {
        project_id: projectId,
        feature_id: featureId,
      });
    },
    subscribeGitStatus: (featureId) => subscribeGitStatus(current, featureId),
  };
}

function subscribeGitStatus(connection: AppWsConnection | null, featureId: number): () => void {
  if (!connection?.ws.isOpen()) return () => {};
  sendAppEnvelope(connection.ws, "subscribe.git_status", { feature_id: featureId });
  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    if (connection.isCurrent() && connection.ws.isOpen()) {
      sendAppEnvelope(connection.ws, "unsubscribe.git_status", { feature_id: featureId });
    }
  };
}
