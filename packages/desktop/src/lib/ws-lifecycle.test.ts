// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConnectionStatusStore } from "@/stores/connection-status-store";
import type { WebSocketLike, WsConnection } from "./ws-connection";
import { openLifecycleSocket, retireSocket, type LifecycleSocketOptions } from "./ws-lifecycle";
import {
  clearRateLimit,
  clearReconnect,
  isRateLimited,
  WS_RATE_LIMIT_RETRY_MS,
} from "./ws-reconnect";

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  private listeners: Record<string, Array<(event: Event) => void>> = {};
  addEventListener(type: string, listener: (event: Event) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  fire(type: string, event: object = {}): void {
    for (const listener of this.listeners[type] ?? []) listener(event as Event);
  }
  open(): void {
    this.readyState = 1;
    this.fire("open");
  }
  drop(code: number): void {
    this.readyState = 3;
    this.fire("close", { code });
  }
}

const KEY = "lifecycle-test";

function setup(overrides: Partial<LifecycleSocketOptions> = {}) {
  const sockets: FakeSocket[] = [];
  const calls: string[] = [];
  let current: WsConnection | null = null;
  const options: LifecycleSocketOptions = {
    key: KEY,
    url: "ws://service/ws",
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    statusLabel: "Test WebSocket",
    isCurrent: (connection) => connection === current,
    onConnected: () => calls.push("connected"),
    replay: () => calls.push("replay"),
    resync: () => calls.push("resync"),
    onMessage: (data) => calls.push(`message:${data}`),
    onDrop: (drop) => calls.push(`drop:${drop.cause}:${drop.code}:${drop.opened}`),
    reconnect: () => {
      current = openLifecycleSocket(options);
    },
    ...overrides,
  };
  const connect = (): WsConnection => {
    current = openLifecycleSocket(options);
    return current;
  };
  return { sockets, calls, connect, release: () => (current = null) };
}

const status = () => useConnectionStatusStore.getState().sources[KEY];

describe("openLifecycleSocket", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    clearRateLimit();
    clearReconnect(KEY);
    retireSocket(KEY);
    vi.useRealTimers();
  });

  it("reports the source, then marks it connected, replays and resyncs, in that order", () => {
    const { sockets, calls, connect } = setup();
    connect();
    sockets[0].open();
    expect(calls).toEqual(["connected", "replay", "resync"]);
    expect(status()?.status).toBe("connected");
  });

  it("ignores every event of a socket its owner no longer holds", () => {
    const { sockets, calls, connect, release } = setup();
    connect();
    release();
    sockets[0].open();
    sockets[0].fire("message", { data: "late" });
    sockets[0].drop(1006);
    expect(calls).toEqual([]);
  });

  it("handles an error and the close behind it as one drop and one retry", async () => {
    const { sockets, calls, connect } = setup();
    connect();
    sockets[0].open();
    sockets[0].fire("error");
    sockets[0].drop(1006);
    expect(calls.filter((call) => call.startsWith("drop"))).toEqual(["drop:error:null:true"]);
    expect(status()).toEqual({ status: "reconnecting", reason: "Test WebSocket error" });
    await vi.advanceTimersByTimeAsync(WS_RATE_LIMIT_RETRY_MS * 3);
    expect(sockets).toHaveLength(2);
  });

  it("holds every socket off on 1013 and waits the same floor after 1006", async () => {
    for (const code of [1013, 1006]) {
      const { sockets, connect } = setup();
      connect();
      sockets[0].open();
      sockets[0].drop(code);
      expect(isRateLimited()).toBe(code === 1013);
      await vi.advanceTimersByTimeAsync(WS_RATE_LIMIT_RETRY_MS - 100);
      expect(sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(200);
      expect(sockets).toHaveLength(2);
      clearRateLimit();
      clearReconnect(KEY);
    }
  });

  it("retries any other close from the first backoff step and tells the owner why", async () => {
    const { sockets, calls, connect } = setup();
    connect();
    sockets[0].drop(1008);
    expect(calls).toEqual(["drop:close:1008:false"]);
    expect(status()?.reason).toBe("Test WebSocket closed (1008)");
    await vi.advanceTimersByTimeAsync(1_100);
    expect(sockets).toHaveLength(2);
  });

  it("still schedules the retry when the owner's drop handler throws", async () => {
    const failure = new Error("teardown failed");
    const { sockets, connect } = setup({
      onDrop: () => {
        throw failure;
      },
    });
    connect();
    sockets[0].open();
    expect(() => sockets[0].drop(1001)).toThrow(failure);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(sockets).toHaveLength(2);
  });

  it("leaves an intentional close alone", async () => {
    const { sockets, calls, connect } = setup();
    const connection = connect();
    sockets[0].open();
    connection.close();
    sockets[0].drop(1000);
    await vi.advanceTimersByTimeAsync(WS_RATE_LIMIT_RETRY_MS * 3);
    expect(calls).toEqual(["connected", "replay", "resync"]);
    expect(sockets).toHaveLength(1);
  });

  it("reports nothing without a status label, and retries only while asked to", async () => {
    let wanted = false;
    const { sockets, connect } = setup({ statusLabel: undefined, shouldRetry: () => wanted });
    connect();
    sockets[0].open();
    sockets[0].drop(1001);
    expect(status()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(WS_RATE_LIMIT_RETRY_MS * 3);
    expect(sockets).toHaveLength(1);

    wanted = true;
    connect();
    sockets[1].drop(1001);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(sockets).toHaveLength(3);
  });
});
