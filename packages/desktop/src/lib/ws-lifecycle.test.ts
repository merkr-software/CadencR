// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConnectionStatusStore } from "@/stores/connection-status-store";
import { formatConnectionReason } from "./connection-reason";
import { translateUi, uiI18n } from "./i18n/ui";
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
  drop(code: number, reason = ""): void {
    this.readyState = 3;
    this.fire("close", { code, reason });
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
    statusChannel: "session",
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
const reasonLabel = () => {
  const reason = status()?.reason;
  return reason ? formatConnectionReason(reason, translateUi, "en") : null;
};

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
    expect(status()?.status).toBe("reconnecting");
    expect(reasonLabel()).toBe("Session WebSocket error");
    await vi.advanceTimersByTimeAsync(WS_RATE_LIMIT_RETRY_MS * 3);
    expect(sockets).toHaveLength(2);
  });

  it("keeps an identical drop stable and renders its channel in the current language", () => {
    const { sockets, connect } = setup({ shouldRetry: () => false });
    connect();
    sockets[0].drop(1008);
    const first = useConnectionStatusStore.getState();
    connect();
    sockets[1].drop(1008);
    expect(useConnectionStatusStore.getState()).toBe(first);

    uiI18n.addResourceBundle("fr", "ui", {
      conversation: {
        connection: {
          sessionSocket: "WebSocket de session",
          socketClosed: "{{label}} fermé ({{code}})",
        },
      },
    });
    try {
      const reason = first.reason;
      expect(reason && formatConnectionReason(reason, uiI18n.getFixedT("fr", "ui"), "fr")).toBe(
        "WebSocket de session fermé (1008)",
      );
    } finally {
      uiI18n.removeResourceBundle("fr", "ui");
    }

    connect();
    sockets[2].drop(1006);
    expect(reasonLabel()).toBe("Session WebSocket closed (1006)");
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
    expect(reasonLabel()).toBe("Session WebSocket closed (1008)");
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

  it("reports nothing without a status channel, and retries only while asked to", async () => {
    let wanted = false;
    const { sockets, connect } = setup({ statusChannel: undefined, shouldRetry: () => wanted });
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

  it("isolates 1013 overloaded backpressure to the dropped socket without global rate-limiting", async () => {
    const { sockets, connect } = setup();
    connect();
    sockets[0].open();
    sockets[0].drop(1013, "overloaded");

    expect(isRateLimited()).toBe(false);
    expect(status()?.status).toBe("reconnecting");
    expect(reasonLabel()).toBe("Session WebSocket overloaded; reconnecting");

    // Uses normal per-socket backoff (~1s) rather than the 5s global rate-limit floor.
    await vi.advanceTimersByTimeAsync(1_100);
    expect(sockets).toHaveLength(2);
  });

  it("still applies the global rate-limit hold for 1013 rate-limited closes", async () => {
    const { sockets, connect } = setup();
    connect();
    sockets[0].open();
    sockets[0].drop(1013, "rate-limited");

    expect(isRateLimited()).toBe(true);
    expect(reasonLabel()).toContain("rate limited");
    await vi.advanceTimersByTimeAsync(WS_RATE_LIMIT_RETRY_MS - 100);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(sockets).toHaveLength(2);
  });
});
