import type { StoreApi } from "zustand";
import { toast } from "sonner";
import { createEnvelope, parseEnvelope } from "@/lib/ws-envelope";
import { getWsProtocols, getWsUrl } from "@/lib/ws-url";
import {
  reportManualReconnectRequired,
  useConnectionStatusStore,
} from "@/stores/connection-status-store";
import {
  registerReconnector,
  resetReconnectState,
  scheduleReconnect,
  unregisterReconnector,
  WS_RATE_LIMIT_RETRY_MS,
} from "@/lib/ws-reconnect";
import { isBrowserRemote } from "@/lib/remote/device-token";
import { hydratePrStatuses } from "@/stores/pr-status-hydration";
import { subscribeForgeStatus } from "@/stores/forge-visibility";
import { clearStorageMaintenanceStatus } from "@/stores/storage-maintenance-store";
import { resetServerClock } from "@/lib/server-clock";
import type { EnvelopeDispatcher, SessionStatusState } from "@/stores/session-status-store";

const APP_WS_SOURCE = "app-ws";

type SessionStatusSet = StoreApi<SessionStatusState>["setState"];
type SessionStatusGet = StoreApi<SessionStatusState>["getState"];
interface AppWsConnection {
  ws: WebSocket;
  set: SessionStatusSet;
  dispatchEnvelope: EnvelopeDispatcher;
  isCurrent: () => boolean;
  unsubscribeForgeVisibility: () => void;
}

function handleAppWsOpen(connection: AppWsConnection): void {
  const { ws, set } = connection;
  resetReconnectState(APP_WS_SOURCE);
  resetServerClock();
  set((state) => ({ isConnected: true, connectionEpoch: state.connectionEpoch + 1 }));
  useConnectionStatusStore.getState().reportSource(APP_WS_SOURCE, "connected");
  ws.send(JSON.stringify(createEnvelope("app", "subscribe.session_status", {})));
  ws.send(JSON.stringify(createEnvelope("app", "subscribe.feature_events", {})));
  // An agent's project_archive_session: the Archive dialog's toast and teardown.
  ws.send(JSON.stringify(createEnvelope("app", "subscribe.agent_archived_events", {})));
  // A schedule fires on the server's clock, into a conversation this client
  // need not have open, so nothing else tells the sidebar its rules moved.
  ws.send(JSON.stringify(createEnvelope("app", "subscribe.schedule_events", {})));
  ws.send(JSON.stringify(createEnvelope("app", "subscribe.settings_events", {})));
  ws.send(JSON.stringify(createEnvelope("app", "subscribe.theme_events", {})));
  // Custom tab folders changed on disk: refetch the list, reload live tabs.
  ws.send(JSON.stringify(createEnvelope("app", "subscribe.plugin_tab_events", {})));
  // Prompts queued for after a turn: delivery happens server-side at turn end.
  ws.send(JSON.stringify(createEnvelope("app", "subscribe.prompt_queue_events", {})));
  ws.send(JSON.stringify(createEnvelope("app", "subscribe.custom_action_events", {})));
  ws.send(JSON.stringify(createEnvelope("app", "subscribe.alacritty_config_events", {})));
  ws.send(JSON.stringify(createEnvelope("app", "subscribe.storage_maintenance_events", {})));
  // Which agents the last restart interrupted, and which were resumed.
  ws.send(JSON.stringify(createEnvelope("app", "subscribe.restart_continuation_events", {})));
  connection.unsubscribeForgeVisibility = subscribeForgeStatus(ws);
  void hydratePrStatuses();
  if (!isBrowserRemote()) {
    ws.send(JSON.stringify(createEnvelope("app", "subscribe.remote_events", {})));
    // Version checks and update outcomes toast on the host only: updates run
    // on this machine. The subscription starts with the current status list.
    ws.send(JSON.stringify(createEnvelope("app", "subscribe.provider_update_events", {})));
  }
}

function handleAppWsError(connection: AppWsConnection): void {
  connection.set({ isConnected: false });
  useConnectionStatusStore
    .getState()
    .reportSource(APP_WS_SOURCE, "reconnecting", "App WebSocket error");
}

function handleAppWsMessage(connection: AppWsConnection, event: MessageEvent): void {
  let envelope: ReturnType<typeof parseEnvelope>;
  try {
    envelope = parseEnvelope(event.data as string);
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
  const retireCurrent = (): void => {
    const previous = current;
    current = null;
    if (!previous) return;
    previous.unsubscribeForgeVisibility();
    clearStorageMaintenanceStatus();
    previous.ws.close();
  };
  const connect = (): void => {
    registerReconnector(
      APP_WS_SOURCE,
      () => {
        retireCurrent();
        set({ isConnected: false });
        get().connect();
      },
      { onManualRequired: reportManualReconnectRequired },
    );
    if (
      current &&
      (current.ws.readyState === WebSocket.OPEN || current.ws.readyState === WebSocket.CONNECTING)
    )
      return;
    retireCurrent();
    const protocols = getWsProtocols();
    const ws = new WebSocket(getWsUrl(), protocols.length ? protocols : undefined);
    const connection: AppWsConnection = {
      ws,
      set,
      dispatchEnvelope,
      isCurrent: () => current === connection,
      unsubscribeForgeVisibility: () => {},
    };
    current = connection;
    ws.addEventListener("open", () => {
      if (connection.isCurrent()) handleAppWsOpen(connection);
    });
    ws.addEventListener("message", (event) => {
      if (connection.isCurrent()) handleAppWsMessage(connection, event);
    });
    ws.addEventListener("error", () => {
      if (connection.isCurrent()) handleAppWsError(connection);
    });
    ws.addEventListener("close", (event) => {
      if (!connection.isCurrent()) return;
      current = null;
      connection.unsubscribeForgeVisibility();
      clearStorageMaintenanceStatus();
      set({ isConnected: false });
      useConnectionStatusStore
        .getState()
        .reportSource(APP_WS_SOURCE, "reconnecting", "App WebSocket dropped");
      scheduleReconnect(APP_WS_SOURCE, () => get().connect(), {
        minimumDelayMs:
          event.code === 1006 || event.code === 1013 ? WS_RATE_LIMIT_RETRY_MS : undefined,
      });
    });
  };
  return {
    connect,
    disconnect() {
      unregisterReconnector(APP_WS_SOURCE);
      retireCurrent();
      useConnectionStatusStore.getState().clearSource(APP_WS_SOURCE);
      set({ isConnected: false });
    },
    subscribeFileWatcher(projectId, featureId) {
      const connection = current;
      if (!connection || connection.ws.readyState !== WebSocket.OPEN) return;
      connection.ws.send(
        JSON.stringify(
          createEnvelope("app", "subscribe.file_watcher", {
            project_id: projectId,
            feature_id: featureId,
          }),
        ),
      );
    },
    subscribeGitStatus: (featureId) => subscribeGitStatus(current, featureId),
  };
}

function subscribeGitStatus(connection: AppWsConnection | null, featureId: number): () => void {
  if (!connection || connection.ws.readyState !== WebSocket.OPEN) return () => {};
  connection.ws.send(
    JSON.stringify(createEnvelope("app", "subscribe.git_status", { feature_id: featureId })),
  );
  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    if (connection.isCurrent() && connection.ws.readyState === WebSocket.OPEN) {
      connection.ws.send(
        JSON.stringify(createEnvelope("app", "unsubscribe.git_status", { feature_id: featureId })),
      );
    }
  };
}
