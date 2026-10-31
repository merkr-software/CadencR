import { installSessionPresentationEffects } from "./ws-session-store";
// @vitest-environment happy-dom
/**
 * Delivery of prompts that cannot leave immediately (issue #251): the
 * composer awaits `deliverPrompt`, so it must settle exactly when the held
 * prompt reaches the wire, and reject when it never will.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useWsSessionStore } from "./ws-session-store";
import { createWsSessionStore } from "./ws-session-store";
import { createStore } from "zustand/vanilla";
import { createSessionEnvelope } from "@/lib/ws-envelope";
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

let disposePresentation: () => void;

beforeEach(() => {
  disposePresentation = installSessionPresentationEffects({ onUserPromptDispatched: vi.fn() });
  MockWebSocket.reset();
  useWsSessionStore.setState({ sessions: {} });
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  disposePresentation();
  const store = useWsSessionStore.getState();
  for (const sessionId of Object.keys(store.sessions)) {
    store.disconnect(sessionId);
  }
  for (const id of activeTimerIds) clearTimeout(id);
  activeTimerIds.clear();
  vi.restoreAllMocks();
});

type Outcome = "pending" | "delivered" | Error;

function track(promise: Promise<void>): { outcome: Outcome } {
  const state: { outcome: Outcome } = { outcome: "pending" };
  promise.then(
    () => (state.outcome = "delivered"),
    (error: Error) => (state.outcome = error),
  );
  return state;
}

async function connectAndInit(sessionId = "s1"): Promise<{ ws: MockWebSocket; initId: string }> {
  const store = useWsSessionStore.getState();
  store.connect(sessionId);
  await tick();
  store.initSession(sessionId, { cwd: "/repo", featureId: 7 });
  const ws = getWs();
  const init = JSON.parse(ws.sent.at(-1) ?? "{}") as { id: string; action: string };
  expect(init.action).toBe("init");
  return { ws, initId: init.id };
}

describe("ws-session queued prompt delivery", () => {
  it("settles a queued prompt only once initialization flushes it", async () => {
    const { ws, initId } = await connectAndInit();
    expect(useWsSessionStore.getState().sessions.s1.initRequestId).toBe(initId);

    const delivery = track(useWsSessionStore.getState().deliverPrompt("s1", "hello"));
    await tick();
    expect(delivery.outcome).toBe("pending");
    expect(sentActions(ws)).not.toContain("session.prompt.send");

    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      ref: initId,
      payload: { session_id: "srv-1" },
    });
    await tick();

    expect(delivery.outcome).toBe("delivered");
    expect(sentActions(ws)).toContain("session.prompt.send");
    const session = useWsSessionStore.getState().sessions.s1;
    expect(session.queuedPrompts).toHaveLength(0);
    expect(session.initRequestId).toBeNull();
  });

  it("settles immediately for an initialized session", async () => {
    const { ws, initId } = await connectAndInit();
    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      ref: initId,
      payload: { session_id: "srv-1" },
    });

    const delivery = track(useWsSessionStore.getState().deliverPrompt("s1", "hello"));
    await tick();

    expect(delivery.outcome).toBe("delivered");
    expect(sentActions(ws)).toContain("session.prompt.send");
  });

  it("rejects and drops the queue when the backend refuses session.init", async () => {
    const { ws, initId } = await connectAndInit();
    const delivery = track(useWsSessionStore.getState().deliverPrompt("s1", "hello"));

    ws.simulateMessage({
      domain: "session",
      action: "error",
      ref: initId,
      payload: { code: "DB_ERROR", message: "Failed to create/find session in database" },
    });
    await tick();

    expect(delivery.outcome).toBeInstanceOf(Error);
    expect((delivery.outcome as Error).message).toBe(
      "The session could not start: Failed to create/find session in database",
    );
    const session = useWsSessionStore.getState().sessions.s1;
    expect(session.queuedPrompts).toHaveLength(0);
    expect(session.initRequestId).toBeNull();
  });

  it("ignores session errors that answer another request", async () => {
    const { ws } = await connectAndInit();
    const delivery = track(useWsSessionStore.getState().deliverPrompt("s1", "hello"));

    ws.simulateMessage({
      domain: "session",
      action: "error",
      ref: "some-other-request",
      payload: { code: "INVALID", message: "nope" },
    });
    await tick();

    expect(delivery.outcome).toBe("pending");
    expect(useWsSessionStore.getState().sessions.s1.queuedPrompts).toHaveLength(1);
  });

  it("keeps the prompt queued but forgets the lost init when the socket drops", async () => {
    const { ws } = await connectAndInit();
    const delivery = track(useWsSessionStore.getState().deliverPrompt("s1", "hello"));

    ws.readyState = MockWebSocket.CLOSED;
    ws.fireEvent("close", { code: 1006 });
    await tick();

    expect(delivery.outcome).toBe("pending");
    const session = useWsSessionStore.getState().sessions.s1;
    expect(session.queuedPrompts).toHaveLength(1);
    expect(session.initRequestId).toBeNull();
  });

  it("forgets a sent init on a forced reconnect so the queued prompt can retry it", async () => {
    await connectAndInit();
    const delivery = track(useWsSessionStore.getState().deliverPrompt("s1", "hello"));

    // Wake-style reconnect: the close handler ignores this intentional close.
    forceReconnectAll();
    await tick();

    expect(delivery.outcome).toBe("pending");
    const session = useWsSessionStore.getState().sessions.s1;
    expect(session.queuedPrompts).toHaveLength(1);
    expect(session.initRequestId).toBeNull();
  });

  it("rejects pending deliveries when the session is torn down", async () => {
    await connectAndInit();
    const delivery = track(useWsSessionStore.getState().deliverPrompt("s1", "hello"));

    useWsSessionStore.getState().disconnect("s1");
    await tick();

    expect(delivery.outcome).toBeInstanceOf(Error);
    expect((delivery.outcome as Error).message).toBe(
      "The session closed before the message was sent.",
    );
  });
  it("rejects pending deliveries when the backend deletes the session", async () => {
    const { ws } = await connectAndInit();
    const delivery = track(useWsSessionStore.getState().deliverPrompt("s1", "hello"));

    ws.simulateMessage({ domain: "session", action: "deleted", payload: {} });
    await tick();

    expect(delivery.outcome).toBeInstanceOf(Error);
    expect(useWsSessionStore.getState().sessions.s1).toBeUndefined();
  });

  it("rejects right away when the session entry does not exist", async () => {
    const delivery = track(useWsSessionStore.getState().deliverPrompt("missing", "hello"));
    await tick();

    expect(delivery.outcome).toBeInstanceOf(Error);
    expect(useWsSessionStore.getState().sessions.missing).toBeUndefined();
  });

  it("keeps an init parked in the outbound queue in flight across a drop", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();
    ws.readyState = MockWebSocket.CLOSED;
    store.initSession("s1", { cwd: "/repo", featureId: 7 });
    const { initRequestId } = useWsSessionStore.getState().sessions.s1;
    expect(ws.sent).not.toContainEqual(expect.stringContaining(initRequestId ?? "missing-init"));

    ws.fireEvent("close", { code: 1006 });

    // The parked init is replayed on reconnect, so no second init may start.
    expect(useWsSessionStore.getState().sessions.s1.initRequestId).toBe(initRequestId);
  });
  it("keeps a prompt parked during a socket drop pending until the reconnect flush", async () => {
    const { ws, initId } = await connectAndInit();
    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      ref: initId,
      payload: { session_id: "srv-1" },
    });
    ws.readyState = MockWebSocket.CLOSED;
    ws.fireEvent("close", { code: 1006 });

    const delivery = track(useWsSessionStore.getState().deliverPrompt("s1", "hello"));
    await tick();
    expect(delivery.outcome).toBe("pending");

    useWsSessionStore.getState().connect("s1");
    await tick();

    expect(delivery.outcome).toBe("delivered");
    expect(sentActions(getWs())).toContain("session.prompt.send");
  });

  it("rejects a prompt parked during a socket drop when the session is torn down", async () => {
    const { ws, initId } = await connectAndInit();
    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      ref: initId,
      payload: { session_id: "srv-1" },
    });
    ws.readyState = MockWebSocket.CLOSED;
    ws.fireEvent("close", { code: 1006 });
    const delivery = track(useWsSessionStore.getState().deliverPrompt("s1", "hello"));

    useWsSessionStore.getState().disconnect("s1");
    await tick();

    expect(delivery.outcome).toBeInstanceOf(Error);
  });
});

describe("store-owned transport resources", () => {
  it("keeps the surviving store reconnectable after another releases the same session id", async () => {
    const creator = createWsSessionStore({ onUserPromptDispatched: vi.fn() });
    const first = createStore(creator);
    const second = createStore(creator);
    first.getState().connect("same-session");
    second.getState().connect("same-session");
    const secondWs = getWs();
    await tick();
    secondWs.readyState = MockWebSocket.CLOSED;
    secondWs.fireEvent("close", { code: 1000 });
    first.getState().release("same-session");

    forceReconnectAll();
    await tick();

    expect(MockWebSocket.instances).toHaveLength(3);
    expect(getWs()).not.toBe(secondWs);
    expect(second.getState().sessions["same-session"].isConnected).toBe(true);
    expect(first.getState().sessions["same-session"]).toBeUndefined();
    second.getState().release("same-session");
  });

  it("isolates queued deliveries for matching session and message identities", async () => {
    const onUserPromptDispatched = vi.fn();
    const creator = createWsSessionStore({ onUserPromptDispatched });
    const first = createStore(creator);
    const second = createStore(creator);
    first.getState().connect("same-session");
    const firstWs = getWs();
    second.getState().connect("same-session");
    const secondWs = getWs();
    await tick();
    first.getState().initSession("same-session", { cwd: "/repo", featureId: 7 });
    second.getState().initSession("same-session", { cwd: "/repo", featureId: 7 });

    const messageUuid = "63f395ef-6b84-4567-868f-63acc34d8ed0";
    const firstDelivery = track(
      first.getState().deliverPrompt("same-session", "first", { messageUuid }),
    );
    const secondDelivery = track(
      second.getState().deliverPrompt("same-session", "second", { messageUuid }),
    );
    const visible = second.getState().sessions["same-session"];
    expect(visible).not.toHaveProperty("conn");
    expect(visible).not.toHaveProperty("pendingWsRequests");
    expect(visible).not.toHaveProperty("outboundQueue");

    first.getState().release("same-session");
    await tick();
    expect(firstDelivery.outcome).toBeInstanceOf(Error);
    expect(secondDelivery.outcome).toBe("pending");
    expect(secondWs.readyState).toBe(MockWebSocket.OPEN);
    expect(firstWs.readyState).toBe(MockWebSocket.CLOSED);
    expect(sentActions(firstWs)).not.toContain("session.destroy");

    secondWs.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "server-session" },
    });
    await tick();
    expect(secondDelivery.outcome).toBe("delivered");
    const sentPrompt = secondWs.sent.find((raw) => raw.includes("prompt.send"));
    expect(sentPrompt).toContain("second");
    expect(sentPrompt).not.toContain("first");
    // Replaying a queued prompt is not a second user dispatch.
    expect(onUserPromptDispatched).toHaveBeenCalledTimes(2);
    expect(onUserPromptDispatched).toHaveBeenNthCalledWith(1, 7);
    expect(onUserPromptDispatched).toHaveBeenNthCalledWith(2, 7);
    second.getState().release("same-session");
  });

  it("isolates correlated replies and rejects only the closing store's pending request", async () => {
    const creator = createWsSessionStore({ onUserPromptDispatched: vi.fn() });
    const first = createStore(creator);
    const second = createStore(creator);
    first.getState().connect("same-session");
    const firstWs = getWs();
    second.getState().connect("same-session");
    const secondWs = getWs();
    await tick();
    const envelope = createSessionEnvelope("retry_worktree_setup", { feature_id: 7 });
    const firstRequest = first.getState().sendRequest("same-session", envelope);
    let secondSettled = false;
    const secondRequest = second.getState().sendRequest("same-session", envelope);
    void secondRequest.then(() => {
      secondSettled = true;
    });

    first.getState().release("same-session");
    await expect(firstRequest).resolves.toBeNull();
    expect(secondSettled).toBe(false);
    // A callback retained by the released socket cannot reach the other store.
    firstWs.simulateMessage({
      domain: "session",
      action: "acknowledged",
      ref: envelope.id,
      payload: { stale: true },
    });
    expect(secondSettled).toBe(false);
    secondWs.simulateMessage({
      domain: "session",
      action: "acknowledged",
      ref: envelope.id,
      payload: { accepted: true },
    });
    await expect(secondRequest).resolves.toEqual({ accepted: true });
    second.getState().release("same-session");
  });
});
