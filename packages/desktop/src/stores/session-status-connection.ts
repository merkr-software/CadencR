import type { StoreApi } from "zustand";
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
import type { EnvelopeDispatcher, SessionStatusState } from "@/stores/session-status-store";

const APP_WS_SOURCE = "app-ws";

type SessionStatusSet = StoreApi<SessionStatusState>["setState"];
type SessionStatusGet = StoreApi<SessionStatusState>["getState"];
type IntentionalCloseWebSocket = WebSocket & {
  __intentionalClose?: () => void;
};

function registerAppWsReconnector(set: SessionStatusSet, get: SessionStatusGet): void {
  registerReconnector(
    APP_WS_SOURCE,
    () => {
      const live = get().ws;
      if (live && live.readyState !== WebSocket.CLOSED) {
        (live as IntentionalCloseWebSocket).__intentionalClose?.();
        live.close();
      }
      set({ ws: null, isConnected: false });
      get().connect();
    },
    { onManualRequired: reportManualReconnectRequired },
  );
}

interface AppWsConnection {
  ws: WebSocket;
  set: SessionStatusSet;
  get: SessionStatusGet;
  dispatchEnvelope: EnvelopeDispatcher;
  intentionalClose: boolean;
  unsubscribeForgeVisibility: () => void;
}

function handleAppWsOpen(connection: AppWsConnection): void {
  const { ws, set } = connection;
  resetReconnectState(APP_WS_SOURCE);
  set({ isConnected: true });
  useConnectionStatusStore.getState().reportSource(APP_WS_SOURCE, "connected");
  ws.send(JSON.stringify(createEnvelope("app", "subscribe.session_status", {})));
  ws.send(JSON.stringify(createEnvelope("app", "subscribe.feature_events", {})));
  ws.send(JSON.stringify(createEnvelope("app", "subscribe.settings_events", {})));
  connection.unsubscribeForgeVisibility = subscribeForgeStatus(ws);
  void hydratePrStatuses();
  if (!isBrowserRemote()) {
    ws.send(JSON.stringify(createEnvelope("app", "subscribe.remote_events", {})));
  }
}

function handleAppWsClose(connection: AppWsConnection, event: CloseEvent): void {
  const { ws, set, get, intentionalClose } = connection;
  connection.unsubscribeForgeVisibility();
  if (get().ws === ws) set({ isConnected: false, ws: null });
  if (intentionalClose) {
    useConnectionStatusStore.getState().clearSource(APP_WS_SOURCE);
    return;
  }
  useConnectionStatusStore
    .getState()
    .reportSource(APP_WS_SOURCE, "reconnecting", "App WebSocket dropped");
  scheduleReconnect(APP_WS_SOURCE, () => get().connect(), {
    minimumDelayMs: event.code === 1006 || event.code === 1013 ? WS_RATE_LIMIT_RETRY_MS : undefined,
  });
}

function handleAppWsError(connection: AppWsConnection): void {
  const { ws, set, get, intentionalClose } = connection;
  if (get().ws === ws) set({ isConnected: false });
  if (!intentionalClose) {
    useConnectionStatusStore
      .getState()
      .reportSource(APP_WS_SOURCE, "reconnecting", "App WebSocket error");
  }
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
  }
}

function attachAppWsListeners(connection: AppWsConnection): void {
  connection.ws.addEventListener("open", () => handleAppWsOpen(connection));
  connection.ws.addEventListener("close", (event) => handleAppWsClose(connection, event));
  connection.ws.addEventListener("error", () => handleAppWsError(connection));
  connection.ws.addEventListener("message", (event) => handleAppWsMessage(connection, event));
}

export function createAppWsConnect(
  set: SessionStatusSet,
  get: SessionStatusGet,
  dispatchEnvelope: EnvelopeDispatcher,
): () => void {
  return function connect(): void {
    registerAppWsReconnector(set, get);
    const existing = get().ws;
    if (
      existing &&
      (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    const protocols = getWsProtocols();
    const ws = new WebSocket(getWsUrl(), protocols.length ? protocols : undefined);
    const connection: AppWsConnection = {
      ws,
      set,
      get,
      dispatchEnvelope,
      intentionalClose: false,
      unsubscribeForgeVisibility: () => {},
    };
    attachAppWsListeners(connection);
    (ws as IntentionalCloseWebSocket).__intentionalClose = () => {
      connection.intentionalClose = true;
    };
    set({ ws });
  };
}

export function createAppWsDisconnect(set: SessionStatusSet, get: SessionStatusGet): () => void {
  return function disconnect(): void {
    unregisterReconnector(APP_WS_SOURCE);
    useConnectionStatusStore.getState().clearSource(APP_WS_SOURCE);
    const ws = get().ws;
    if (ws) {
      (ws as IntentionalCloseWebSocket).__intentionalClose?.();
      ws.close();
    }
    set({ ws: null, isConnected: false });
  };
}
