// @vitest-environment happy-dom
/**
 * The agent session socket through the shared lifecycle (`lib/ws-lifecycle`):
 * a drop, the retry, and what the new socket replays.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRateLimit, WS_RATE_LIMIT_RETRY_MS } from "@/lib/ws-reconnect";
import { installSessionPresentationEffects, useWsSessionStore } from "./ws-session-store";
import { WS_RECONNECTING_CODE } from "./ws-session-types";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    dismiss: vi.fn(),
    success: vi.fn(),
    loading: vi.fn(),
  }),
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
  /** What a browser reports when the service goes away: an error, then 1006. */
  dropAbnormally() {
    this.readyState = 3;
    this.fire("error");
    this.fire("close", { code: 1006 });
  }
  receive(action: string, payload: unknown) {
    this.fire("message", {
      data: JSON.stringify({ id: crypto.randomUUID(), domain: "session", action, payload }),
    });
  }
  actions(): string[] {
    return this.sent.map((raw) => {
      const envelope = JSON.parse(raw) as { domain: string; action: string };
      return `${envelope.domain}.${envelope.action}`;
    });
  }
}

let disposePresentation: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  disposePresentation = installSessionPresentationEffects({ onUserPromptDispatched: vi.fn() });
  MockWebSocket.instances = [];
  useWsSessionStore.setState({ sessions: {} });
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  disposePresentation();
  const store = useWsSessionStore.getState();
  for (const sessionId of Object.keys(store.sessions)) store.disconnect(sessionId);
  clearRateLimit();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A session whose turn is running, initialized on an open socket. */
function runningSession(): MockWebSocket {
  const store = useWsSessionStore.getState();
  store.connect("s1");
  const ws = MockWebSocket.instances[0];
  ws.open();
  store.initSession("s1", { cwd: "/tmp/proj", featureId: 42 });
  ws.receive("initialized", { session_id: "7" });
  useWsSessionStore.setState((state) => ({
    sessions: { ...state.sessions, s1: { ...state.sessions.s1, lifecycle: { phase: "active" } } },
  }));
  return ws;
}

describe("agent session socket lifecycle", () => {
  it("treats an abnormal drop mid-turn as a lost connection, not a turn error", () => {
    runningSession().dropAbnormally();

    const session = useWsSessionStore.getState().sessions.s1;
    expect(session.isConnected).toBe(false);
    expect(session.lifecycle.phase).not.toBe("error");
    expect(session.blocks.at(-1)?.errorCode).toBe(WS_RECONNECTING_CODE);
    expect(session.blocks.filter((block) => block.errorCode === WS_RECONNECTING_CODE)).toHaveLength(
      1,
    );
  });

  it("reconnects after the retry floor, replays init, then what was queued during the gap", async () => {
    runningSession().dropAbnormally();
    // A prompt is held for the reconnect (a setting would expire with its
    // queue TTL, which equals the retry floor, and be reported unsent).
    useWsSessionStore.getState().sendPrompt("s1", "sent during the gap");

    await vi.advanceTimersByTimeAsync(WS_RATE_LIMIT_RETRY_MS - 100);
    expect(MockWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(MockWebSocket.instances).toHaveLength(2);

    const next = MockWebSocket.instances[1];
    next.open();
    expect(useWsSessionStore.getState().sessions.s1.isConnected).toBe(true);
    expect(
      next.actions().filter((a) => a === "session.init" || a === "session.prompt.send"),
    ).toEqual(["session.init", "session.prompt.send"]);
    expect(next.sent.some((raw) => raw.includes("sent during the gap"))).toBe(true);
  });

  it("ignores the close that follows an error: one drop, one retry", async () => {
    const ws = runningSession();
    ws.fire("error");
    ws.fire("close", { code: 1006 });
    ws.fire("close", { code: 1006 });
    await vi.advanceTimersByTimeAsync(WS_RATE_LIMIT_RETRY_MS * 2);
    expect(MockWebSocket.instances).toHaveLength(2);
  });
});
