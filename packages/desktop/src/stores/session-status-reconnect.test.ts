// @vitest-environment happy-dom
/**
 * The app socket (session status, app events) through the shared lifecycle
 * (`lib/ws-lifecycle`), with the real reconnect registry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import {
  clearRateLimit,
  isRateLimited,
  unregisterReconnector,
  WS_RATE_LIMIT_RETRY_MS,
} from "@/lib/ws-reconnect";
import { createAppWsConnection } from "./session-status-connection";
import type { SessionStatusState } from "./session-status-store";
import { useConnectionStatusStore } from "./connection-status-store";

vi.mock("./forge-visibility", () => ({ subscribeForgeStatus: vi.fn(() => vi.fn()) }));
vi.mock("./pr-status-hydration", () => ({
  hydratePrStatuses: vi.fn().mockResolvedValue(undefined),
}));

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readyState = 0;
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
  close() {
    this.readyState = 3;
  }
  fire(event: string, payload: unknown = {}) {
    for (const callback of this.listeners[event] ?? []) callback(payload);
  }
  open() {
    this.readyState = 1;
    this.fire("open");
  }
  drop(code: number) {
    this.readyState = 3;
    this.fire("close", { code });
  }
  subscriptions(): string[] {
    return this.sent
      .map((raw) => (JSON.parse(raw) as { action: string }).action)
      .filter((action) => action.startsWith("subscribe."));
  }
}

function harness() {
  return createStore<SessionStatusState>((set, get) => ({
    bySession: {},
    isConnected: false,
    connectionEpoch: 0,
    hasSnapshot: false,
    epoch: null,
    snapshotSeq: 0,
    ...createAppWsConnection(set, get, vi.fn()),
  }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", MockWebSocket);
  MockWebSocket.instances = [];
});
afterEach(() => {
  clearRateLimit();
  unregisterReconnector("app-ws");
  useConnectionStatusStore.getState().clearSource("app-ws");
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("app socket lifecycle", () => {
  it("holds every socket off on an overload close, then reconnects and replays its subscriptions", async () => {
    const store = harness();
    store.getState().connect();
    const first = MockWebSocket.instances[0];
    first.open();
    const subscribed = first.subscriptions();
    expect(subscribed).toContain("subscribe.session_status");

    first.drop(1013);
    // One overloaded service: the other sockets wait too.
    expect(isRateLimited()).toBe(true);
    expect(store.getState().isConnected).toBe(false);
    expect(useConnectionStatusStore.getState().sources["app-ws"]?.status).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(WS_RATE_LIMIT_RETRY_MS - 100);
    expect(MockWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(MockWebSocket.instances).toHaveLength(2);

    const second = MockWebSocket.instances[1];
    second.open();
    expect(second.subscriptions()).toEqual(subscribed);
    expect(store.getState().connectionEpoch).toBe(2);
    expect(useConnectionStatusStore.getState().sources["app-ws"]?.status).toBe("connected");
    store.getState().disconnect();
  });

  it("retries once for an error and the close that follows it", async () => {
    const store = harness();
    store.getState().connect();
    const first = MockWebSocket.instances[0];
    first.open();
    first.fire("error");
    first.drop(1006);
    await vi.advanceTimersByTimeAsync(WS_RATE_LIMIT_RETRY_MS * 3);
    expect(MockWebSocket.instances).toHaveLength(2);
    store.getState().disconnect();
  });
});
