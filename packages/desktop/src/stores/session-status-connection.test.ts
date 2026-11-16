import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { createAppWsConnection } from "./session-status-connection";
import type { SessionStatusState } from "./session-status-store";
import { registerReconnector, scheduleReconnect } from "@/lib/ws-reconnect";
import { subscribeForgeStatus } from "./forge-visibility";

vi.mock("@/lib/ws-reconnect", () => ({
  registerReconnector: vi.fn(),
  unregisterReconnector: vi.fn(),
  resetReconnectState: vi.fn(),
  scheduleReconnect: vi.fn(),
  WS_RATE_LIMIT_RETRY_MS: 4_000,
}));
vi.mock("./forge-visibility", () => ({ subscribeForgeStatus: vi.fn(() => vi.fn()) }));
vi.mock("./pr-status-hydration", () => ({
  hydratePrStatuses: vi.fn().mockResolvedValue(undefined),
}));

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  private listeners: Record<string, Array<(event: unknown) => void>> = {};
  constructor() {
    MockWebSocket.instances.push(this);
  }
  addEventListener(event: string, callback: (event: unknown) => void) {
    (this.listeners[event] ??= []).push(callback);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
    this.fire("close", { code: 1000 });
  });
  fire(event: string, payload: unknown = {}) {
    for (const callback of this.listeners[event] ?? []) callback(payload);
  }
  open() {
    this.readyState = MockWebSocket.OPEN;
    this.fire("open");
  }
  message() {
    this.fire("message", {
      data: JSON.stringify({
        id: "status",
        domain: "app",
        action: "session_status.snapshot",
        payload: { states: {}, seq: 1 },
      }),
    });
  }
}

function harness() {
  const dispatch = vi.fn();
  const store = createStore<SessionStatusState>((set, get) => ({
    bySession: {},
    isConnected: false,
    connectionEpoch: 0,
    hasSnapshot: false,
    epoch: null,
    snapshotSeq: 0,
    ...createAppWsConnection(set, get, dispatch),
  }));
  return { store, dispatch };
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", MockWebSocket);
  MockWebSocket.instances = [];
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

describe("private app WebSocket controller", () => {
  it("ignores every stale callback after disconnect and cleans forge visibility immediately", () => {
    const { store, dispatch } = harness();
    store.getState().connect();
    const ws = MockWebSocket.instances[0];
    ws.open();
    expect(store.getState().connectionEpoch).toBe(1);
    const unsubscribe = vi.mocked(subscribeForgeStatus).mock.results[0].value;
    store.getState().disconnect();
    expect(unsubscribe).toHaveBeenCalledOnce();
    const disconnected = store.getState();
    ws.open();
    ws.message();
    ws.fire("error");
    ws.fire("close", { code: 1006 });
    expect(store.getState()).toBe(disconnected);
    expect(dispatch).not.toHaveBeenCalled();
    expect(scheduleReconnect).not.toHaveBeenCalled();
    expect(subscribeForgeStatus).toHaveBeenCalledOnce();
    expect("ws" in store.getState()).toBe(false);
  });

  it("captures the exact subscription connection and leaves its replacement untouched", () => {
    const { store, dispatch } = harness();
    store.getState().connect();
    const old = MockWebSocket.instances[0];
    old.open();
    const unsubscribeOld = store.getState().subscribeGitStatus(7);
    const reconnect = vi.mocked(registerReconnector).mock.calls[0][1];
    reconnect();
    const current = MockWebSocket.instances[1];
    current.open();
    expect(store.getState().connectionEpoch).toBe(2);
    const currentMessages = [...current.sent];
    const oldMessages = [...old.sent];
    unsubscribeOld();
    expect(old.sent).toEqual(oldMessages);
    expect(current.sent).toEqual(currentMessages);
    old.message();
    old.open();
    old.fire("close", { code: 1006 });
    expect(store.getState().isConnected).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
    expect(scheduleReconnect).not.toHaveBeenCalled();
    const unsubscribeCurrent = store.getState().subscribeGitStatus(8);
    unsubscribeCurrent();
    expect(JSON.parse(current.sent.at(-1)!)).toMatchObject({
      action: "unsubscribe.git_status",
      payload: { feature_id: 8 },
    });
    store.getState().disconnect();
  });

  it("subscribes file watchers only on an open current connection and connects idempotently", () => {
    const { store } = harness();
    store.getState().subscribeFileWatcher(1, 7);
    store.getState().connect();
    store.getState().connect();
    expect(MockWebSocket.instances).toHaveLength(1);
    const ws = MockWebSocket.instances[0];
    store.getState().subscribeFileWatcher(1, 7);
    expect(ws.sent).toEqual([]);
    ws.open();
    store.getState().subscribeFileWatcher(1, 7);
    expect(JSON.parse(ws.sent.at(-1)!)).toMatchObject({
      action: "subscribe.file_watcher",
      payload: { project_id: 1, feature_id: 7 },
    });
    store.getState().disconnect();
  });
});
