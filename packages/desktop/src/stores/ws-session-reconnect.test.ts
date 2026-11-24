// @vitest-environment happy-dom
/**
 * The agent session socket through the shared lifecycle (`lib/ws-lifecycle`):
 * a drop, the retry, and what the new socket replays.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AxiosError } from "axios";
import { toast } from "sonner";
import * as api from "@/api/generated";
import { clearRateLimit, RECONNECT_INTERVAL_MS, WS_RATE_LIMIT_RETRY_MS } from "@/lib/ws-reconnect";
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
  vi.clearAllMocks();
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

const recovered: api.FeatureAgentStateResponse = {
  sessions: [
    {
      sessionDbId: 7,
      agentType: "claude",
      status: "idle",
      accessMode: "local",
      permissionMode: "default",
      hasFileChanges: false,
      hasMore: false,
      isIncremental: true,
      resumable: true,
      wasCompacted: false,
      inputTokens: 0,
      outputTokens: 0,
      maxMessageId: 12,
      blocks: [{ id: "msg-12", type: "text", content: "Written while disconnected" }],
    },
  ],
};

function session() {
  return useWsSessionStore.getState().sessions.s1;
}

describe("agent session socket lifecycle", () => {
  async function reopenSession() {
    runningSession().dropAbnormally();
    await vi.advanceTimersByTimeAsync(WS_RATE_LIMIT_RETRY_MS);
    const reopened = MockWebSocket.instances[1];
    reopened.open();
    await vi.advanceTimersByTimeAsync(0);
    return reopened;
  }

  it("retries a failed history read on the open socket without replaying commands", async () => {
    const read = vi
      .spyOn(api, "getFeatureAgentState")
      .mockRejectedValueOnce(new AxiosError("Network Error", "ERR_NETWORK"))
      .mockResolvedValue(recovered);
    const socket = await reopenSession();
    const sent = [...socket.sent];
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RECONNECT_INTERVAL_MS);
    expect(read.mock.calls).toEqual([
      [42, { session: 7 }],
      [42, { session: 7 }],
    ]);
    expect(socket.sent).toEqual(sent);
    expect(session().blocks.map((b) => b.content)).toEqual(["Written while disconnected"]);
    expect(session().lastAppliedMessageId).toBe(12);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("offers a manual retry after repeated network failure and keeps the transcript", async () => {
    const read = vi
      .spyOn(api, "getFeatureAgentState")
      .mockRejectedValue(new AxiosError("Network Error", "ERR_NETWORK"));
    await reopenSession();
    await vi.advanceTimersByTimeAsync(RECONNECT_INTERVAL_MS * 10);
    expect(read).toHaveBeenCalledTimes(2);
    expect(session().historyLoadFailure).toEqual({
      resyncSessionDbId: 7,
      retrying: false,
      message: "Network Error",
    });
    expect(session().blocks.some((b) => b.errorCode === WS_RECONNECTING_CODE)).toBe(false);
    expect(session().lastAppliedMessageId).toBeNull();
    read.mockResolvedValue(recovered);
    const store = useWsSessionStore.getState();
    store.retryPersistedLoad("s1");
    store.retryPersistedLoad("s1");
    expect(session().historyLoadFailure?.retrying).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(3);
    expect(session().historyLoadFailure).toBeNull();
    expect(session().blocks.map((b) => b.content)).toEqual(["Written while disconnected"]);
  });

  it.each([
    { sessions: [] },
    { sessions: [{ ...recovered.sessions[0], hasMoreIncrementalMessages: true, maxMessageId: 0 }] },
  ])("keeps incomplete history retryable without advancing its cursor", async (response) => {
    const read = vi.spyOn(api, "getFeatureAgentState").mockResolvedValue(response);
    await reopenSession();
    expect(read).toHaveBeenCalledTimes(1);
    expect(session().historyLoadFailure?.resyncSessionDbId).toBe(7);
    expect(session().lastAppliedMessageId).toBeNull();
    expect(session().blocks.some((b) => b.id === "msg-12")).toBe(false);
    read.mockResolvedValue(recovered);
    useWsSessionStore.getState().retryPersistedLoad("s1");
    await vi.advanceTimersByTimeAsync(0);
    expect(session().lastAppliedMessageId).toBe(12);
    expect(session().historyLoadFailure).toBeNull();
  });

  it("abandons a scheduled read when the session is disconnected", async () => {
    const read = vi
      .spyOn(api, "getFeatureAgentState")
      .mockRejectedValueOnce(new AxiosError("Network Error", "ERR_NETWORK"));
    await reopenSession();
    useWsSessionStore.getState().disconnect("s1");
    await vi.advanceTimersByTimeAsync(RECONNECT_INTERVAL_MS * 2);
    expect(read).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

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
