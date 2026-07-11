/**
 * Outbound-queue behavior of the WS session store: envelopes sent while the
 * socket is down are held and delivered after the reconnect, instead of being
 * silently dropped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useWsSessionStore } from "./ws-session-store";
import { createEnvelope } from "@/lib/ws-envelope";
import { forceReconnectAll } from "@/lib/ws-reconnect";

// --- Mock WebSocket (same shape as ws-session-store.test.ts) ---

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.OPEN;
  sent: string[] = [];
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

  constructor(_url: string) {
    MockWebSocket.instances.push(this);
    Promise.resolve().then(() => this.fireEvent("open"));
  }

  addEventListener(event: string, cb: (...args: unknown[]) => void) {
    (this.listeners[event] ??= []).push(cb);
  }

  removeEventListener() {}

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
  }

  fireEvent(event: string, data?: unknown) {
    for (const cb of this.listeners[event] ?? []) {
      cb(data ?? {});
    }
  }

  simulateMessage(envelope: { domain: string; action: string; ref?: string; payload: unknown }) {
    const raw = JSON.stringify({ id: "srv-1", ...envelope });
    this.fireEvent("message", { data: raw });
  }

  static reset() {
    MockWebSocket.instances = [];
  }
}

const activeTimerIds = new Set<ReturnType<typeof setTimeout>>();

function tick(): Promise<void> {
  return new Promise((resolve) => {
    const id = setTimeout(() => {
      activeTimerIds.delete(id);
      resolve();
    }, 10);
    activeTimerIds.add(id);
  });
}

function getWs(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1];
}

function sentActions(ws: MockWebSocket): string[] {
  return ws.sent.map((raw) => {
    const env = JSON.parse(raw) as { domain: string; action: string };
    return `${env.domain}.${env.action}`;
  });
}

beforeEach(() => {
  MockWebSocket.reset();
  useWsSessionStore.setState({ sessions: {} });
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  const store = useWsSessionStore.getState();
  for (const sessionId of Object.keys(store.sessions)) {
    store.disconnect(sessionId);
  }
  for (const id of activeTimerIds) clearTimeout(id);
  activeTimerIds.clear();
  vi.restoreAllMocks();
});

/** Connect, receive `initialized`, then drop the socket (unintentional close). */
async function connectInitializedThenDrop(sessionId = "s1"): Promise<void> {
  const store = useWsSessionStore.getState();
  store.connect(sessionId);
  await tick();
  const ws = getWs();
  ws.simulateMessage({
    domain: "session",
    action: "initialized",
    payload: { session_id: "7" },
  });
  ws.readyState = MockWebSocket.CLOSED;
  ws.fireEvent("close");
}

describe("ws-session outbound queue", () => {
  it("queues an envelope sent while disconnected and flushes it on reconnect", async () => {
    await connectInitializedThenDrop();
    const store = useWsSessionStore.getState();

    store.interrupt("s1");
    expect(useWsSessionStore.getState().sessions.s1.outboundQueue).toHaveLength(1);

    store.connect("s1");
    await tick();

    expect(sentActions(getWs())).toContain("session.interrupt");
    expect(useWsSessionStore.getState().sessions.s1.outboundQueue).toHaveLength(0);
  });

  it("delivers a prompt sent during the reconnect gap instead of dropping it", async () => {
    await connectInitializedThenDrop();
    const store = useWsSessionStore.getState();

    store.sendPrompt("s1", "hello from the gap");
    // The local echo is appended immediately…
    const blocks = useWsSessionStore.getState().sessions.s1.blocks;
    expect(blocks.at(-1)?.type).toBe("user_message");

    store.connect("s1");
    await tick();

    // …and the prompt actually reaches the backend after the reconnect
    // (toContain also fails when no prompt.send envelope was sent at all).
    const promptRaw = getWs().sent.find((raw) => raw.includes("prompt.send"));
    expect(promptRaw).toContain("hello from the gap");
  });

  it("replays the reconnect session.init before flushing queued envelopes", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    store.initSession("s1", { cwd: "/tmp/proj", featureId: 42 });
    getWs().simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "7" },
    });
    const ws = getWs();
    ws.readyState = MockWebSocket.CLOSED;
    ws.fireEvent("close");

    store.interrupt("s1");
    store.connect("s1");
    await tick();

    // A single assertion covers both presence and relative order.
    const actions = sentActions(getWs());
    const replayThenFlush = actions.filter(
      (action) => action === "session.init" || action === "session.interrupt",
    );
    expect(replayThenFlush).toEqual(["session.init", "session.interrupt"]);
  });

  it("sendRequest during the gap resolves with the reply that arrives after reconnect", async () => {
    await connectInitializedThenDrop();
    const store = useWsSessionStore.getState();

    const envelope = createEnvelope("session", "retry_worktree_setup", { feature_id: 42 });
    const pending = store.sendRequest("s1", envelope);

    store.connect("s1");
    await tick();

    getWs().simulateMessage({
      domain: "session",
      action: "retry_worktree_setup.ok",
      ref: envelope.id,
      payload: { feature_id: 42 },
    });

    await expect(pending).resolves.toEqual({ feature_id: 42 });
  });

  it("disconnect clears any queued envelopes", async () => {
    await connectInitializedThenDrop();
    const store = useWsSessionStore.getState();

    store.interrupt("s1");
    expect(useWsSessionStore.getState().sessions.s1.outboundQueue).toHaveLength(1);

    store.disconnect("s1");
    const session = useWsSessionStore.getState().sessions.s1;
    // The entry may survive (no live conn to tear down) but its queue must not.
    expect(session?.outboundQueue ?? []).toHaveLength(0);
  });

  it("does not resend a sendRequest() envelope that timed out before the reconnect", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();
    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "7" },
    });
    // Socket goes non-OPEN (reconnect window) without a close event, so no
    // auto-reconnect timer competes with the 10s request timeout. This models a
    // long outage where the reconnect lands *after* the request has given up.
    ws.readyState = MockWebSocket.CLOSED;

    vi.useFakeTimers();
    try {
      const envelope = createEnvelope("session", "retry_worktree_setup", { feature_id: 42 });
      const pending = store.sendRequest("s1", envelope);
      expect(useWsSessionStore.getState().sessions.s1.outboundQueue).toHaveLength(1);

      // 10s elapse with the socket still down: the request times out and its
      // envelope must leave the queue instead of lingering as a stale flush.
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(pending).resolves.toBeNull();
      expect(useWsSessionStore.getState().sessions.s1.outboundQueue).toHaveLength(0);

      // The socket comes back: the timed-out envelope must not be replayed.
      ws.readyState = MockWebSocket.OPEN;
      ws.fireEvent("open");
      expect(sentActions(ws)).not.toContain("session.retry_worktree_setup");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a queued sendRequest() envelope when a transient close rejects it", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();
    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "7" },
    });

    // Socket goes non-OPEN (no close event yet): the request gets queued.
    ws.readyState = MockWebSocket.CLOSED;
    const pending = store.sendRequest(
      "s1",
      createEnvelope("session", "retry_worktree_setup", { feature_id: 42 }),
    );
    expect(useWsSessionStore.getState().sessions.s1.outboundQueue).toHaveLength(1);

    // The close lands: the pending-request sweep resolves the promise null
    // and must take the matching queued envelope with it.
    ws.fireEvent("close");
    await expect(pending).resolves.toBeNull();
    expect(useWsSessionStore.getState().sessions.s1.outboundQueue).toHaveLength(0);

    // The reconnect must not replay a request the caller was told failed.
    store.connect("s1");
    await tick();
    expect(sentActions(getWs())).not.toContain("session.retry_worktree_setup");
  });

  it("drops a queued sendRequest() envelope on a forced reconnect", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();
    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "7" },
    });

    ws.readyState = MockWebSocket.CLOSED;
    const pending = store.sendRequest(
      "s1",
      createEnvelope("session", "retry_worktree_setup", { feature_id: 42 }),
    );
    expect(useWsSessionStore.getState().sessions.s1.outboundQueue).toHaveLength(1);

    // Wake-style force reconnect (usePowerEvents.handleResume): closes the
    // old socket, sweeps pending requests, opens a replacement.
    forceReconnectAll();
    await tick();

    await expect(pending).resolves.toBeNull();
    expect(sentActions(getWs())).not.toContain("session.retry_worktree_setup");
  });

  it("resolves an in-flight sendRequest() immediately on disconnect", async () => {
    await connectInitializedThenDrop();
    const store = useWsSessionStore.getState();

    const pending = store.sendRequest(
      "s1",
      createEnvelope("session", "retry_worktree_setup", { feature_id: 42 }),
    );
    store.disconnect("s1");

    // Resolves now instead of hanging until the 10s timeout after teardown.
    await expect(pending).resolves.toBeNull();
  });

  it("resolves an in-flight sendRequest() immediately on destroy", async () => {
    await connectInitializedThenDrop();
    const store = useWsSessionStore.getState();

    const pending = store.sendRequest(
      "s1",
      createEnvelope("session", "retry_worktree_setup", { feature_id: 42 }),
    );
    store.destroy("s1");

    await expect(pending).resolves.toBeNull();
  });
});
