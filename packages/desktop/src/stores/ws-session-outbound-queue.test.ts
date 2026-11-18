import { installSessionPresentationEffects } from "./ws-session-store";
// @vitest-environment happy-dom
/**
 * Outbound-queue behavior of the WS session store: envelopes sent while the
 * socket is down are held and delivered after the reconnect, instead of being
 * silently dropped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useWsSessionStore } from "./ws-session-store";
import { createSessionEnvelope } from "@/lib/ws-envelope";
import { forceReconnectAll } from "@/lib/ws-reconnect";
import { AUTO_RECONNECT_TIMEOUT_MS, WS_RATE_LIMIT_RETRY_MS } from "@/lib/ws-reconnect";
import { SESSION_ACTION } from "./ws-session-action-names";

const { toastError, toastWarning } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastWarning: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: toastError,
    warning: toastWarning,
    info: vi.fn(),
    dismiss: vi.fn(),
    success: vi.fn(),
    loading: vi.fn(),
  }),
}));

// --- Mock WebSocket (same shape as ws-session-store.test.ts) ---

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  /** The service is down: every new socket fails its upgrade. */
  static failOpen = false;

  readyState = MockWebSocket.OPEN;
  sent: string[] = [];
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

  constructor(_url: string) {
    MockWebSocket.instances.push(this);
    Promise.resolve().then(() => {
      if (!MockWebSocket.failOpen) {
        this.fireEvent("open");
        return;
      }
      this.readyState = MockWebSocket.CLOSED;
      this.fireEvent("error");
      this.fireEvent("close", { code: 1006 });
    });
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
  toastError.mockClear();
  toastWarning.mockClear();
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
  it("queues a setting sent while disconnected and flushes it on reconnect", async () => {
    await connectInitializedThenDrop();
    const store = useWsSessionStore.getState();

    store.setModel("s1", "opus", "claude-code");
    expect(useWsSessionStore.getState().sessions.s1.pendingCommandActions).toEqual(["model.set"]);

    store.connect("s1");
    await tick();

    expect(sentActions(getWs())).toContain("session.model.set");
  });

  /** Frames sent on a socket, as `[action, payload]`, for the settings ones. */
  function settingFrames(ws: MockWebSocket): Array<[string, Record<string, unknown>]> {
    return ws.sent
      .map((raw) => JSON.parse(raw) as { action: string; payload: Record<string, unknown> })
      .filter((envelope) => envelope.action.endsWith(".set"))
      .map((envelope) => [envelope.action, envelope.payload]);
  }

  async function confirmedAcceptEditsThenDrop(): Promise<void> {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    store.initSession("s1", { cwd: "/tmp/proj", featureId: 42 });
    const ws = getWs();
    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "7", provider: "claude_code", model: "claude-haiku-5-5" },
    });
    ws.simulateMessage({
      domain: "session",
      action: "mode.changed",
      payload: { mode: "acceptEdits" },
    });
    expect(useWsSessionStore.getState().sessions.s1.permissionMode).toBe("acceptEdits");
    ws.readyState = MockWebSocket.CLOSED;
    ws.fireEvent("close", { code: 1006 });
  }

  it("never lets the reconnect's init replay overwrite a mode chosen during the outage", async () => {
    await confirmedAcceptEditsThenDrop();
    const store = useWsSessionStore.getState();
    store.setPermissionMode("s1", "plan");

    store.connect("s1");
    await tick();
    const ws = getWs();
    // The backend answers the reconnect's session.init with the stored mode.
    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: {
        session_id: "7",
        provider: "claude_code",
        model: "claude-haiku-5-5",
        permission_mode: "acceptEdits",
      },
    });

    expect(settingFrames(ws)).toEqual([["mode.set", { session_id: "7", mode: "plan" }]]);
    ws.simulateMessage({ domain: "session", action: "mode.changed", payload: { mode: "plan" } });
    expect(useWsSessionStore.getState().sessions.s1.permissionMode).toBe("plan");
  });

  it("sends only the settings chosen during the outage after the reconnect", async () => {
    await confirmedAcceptEditsThenDrop();
    const store = useWsSessionStore.getState();
    store.setModel("s1", "claude-sonnet-4-6", "claude_code");
    store.setThinkingEffort("s1", "high");
    store.setPermissionMode("s1", "plan");

    store.connect("s1");
    await tick();
    const ws = getWs();
    ws.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: {
        session_id: "7",
        provider: "claude_code",
        model: "claude-haiku-5-5",
        permission_mode: "acceptEdits",
        thinking_effort: "low",
      },
    });

    expect(
      settingFrames(ws).map(([action, payload]) => [
        action,
        payload.model ?? payload.thinking_effort ?? payload.mode,
      ]),
    ).toEqual([
      ["model.set", "claude-sonnet-4-6"],
      ["effort.set", "high"],
      ["mode.set", "plan"],
    ]);
  });

  it("replays the latest Codex model and effort overrides changed during an outage", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const first = getWs();
    first.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "7", provider: "codex_cli", model: "gpt-a" },
    });
    first.readyState = MockWebSocket.CLOSED;
    first.fireEvent("close", { code: 1006 });

    store.queueRuntimeOverride("s1", { model: "gpt-b" });
    store.queueRuntimeOverride("s1", { thinking_effort: "high" });
    store.queueRuntimeOverride("s1", { model: "gpt-c" });
    // One per field: a newer model replaces the waiting one, the effort stays.
    expect(useWsSessionStore.getState().sessions.s1.queuedCommandActions).toEqual([
      "runtime_overrides.set:thinking_effort",
      "runtime_overrides.set:model",
    ]);
    // Nothing optimistic: the selection is still the confirmed one.
    expect(useWsSessionStore.getState().sessions.s1.currentSelection?.modelId).toBe("gpt-a");

    store.connect("s1");
    await tick();
    const ws = getWs();
    const overrides = ws.sent
      .map(
        (raw) =>
          JSON.parse(raw) as { id: string; action: string; payload: Record<string, unknown> },
      )
      .filter((envelope) => envelope.action === "runtime_overrides.set");
    expect(overrides.map((envelope) => envelope.payload.runtime_overrides)).toEqual([
      { thinking_effort: "high" },
      { model: "gpt-c" },
    ]);

    // The backend confirms through the correlated `runtime_overrides.changed`.
    ws.simulateMessage({
      domain: "session",
      action: "runtime_overrides.changed",
      ref: overrides[1].id,
      payload: {
        runtime_overrides: { model: "gpt-c", thinking_effort: "high", fast_mode: null },
        effective: { model: "gpt-c", thinking_effort: "high", fast_mode: false },
      },
    });
    const session = useWsSessionStore.getState().sessions.s1;
    expect(session.currentSelection?.modelId).toBe("gpt-c");
    // Only the effort change is still unanswered.
    expect(session.pendingCommandActions).toEqual(["runtime_overrides.set:thinking_effort"]);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("replays the latest Codex fast mode change made during an outage", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const first = getWs();
    first.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "7", provider: "codex_cli", model: "gpt-a" },
    });
    first.readyState = MockWebSocket.CLOSED;
    first.fireEvent("close", { code: 1006 });

    store.queueRuntimeOverride("s1", { model: "gpt-b" });
    store.queueRuntimeOverride("s1", { fast_mode: true });
    store.queueRuntimeOverride("s1", { fast_mode: false });
    // One per field: the newer fast mode replaces the waiting one, the model stays.
    const waiting = useWsSessionStore.getState().sessions.s1;
    expect(waiting.queuedCommandActions).toEqual([
      "runtime_overrides.set:model",
      "runtime_overrides.set:fast_mode",
    ]);
    // The fast mode control can tell its own change is waiting, and nothing
    // optimistic: the value shown is still the confirmed one.
    expect(waiting.pendingCommandActions).toContain("runtime_overrides.set:fast_mode");
    expect(waiting.fastMode).toBe(false);

    store.connect("s1");
    await tick();
    const ws = getWs();
    const overrides = ws.sent
      .map(
        (raw) =>
          JSON.parse(raw) as { id: string; action: string; payload: Record<string, unknown> },
      )
      .filter((envelope) => envelope.action === "runtime_overrides.set");
    expect(overrides.map((envelope) => envelope.payload.runtime_overrides)).toEqual([
      { model: "gpt-b" },
      { fast_mode: false },
    ]);

    // A refusal is reported as a fast mode failure, not as another setting's.
    ws.simulateMessage({
      domain: "session",
      action: SESSION_ACTION.error,
      ref: overrides[1].id,
      payload: { code: "INVALID_OVERRIDES", message: "fast mode unavailable" },
    });
    expect(toastError).toHaveBeenCalledWith(
      "Couldn't change fast mode",
      expect.objectContaining({ description: expect.stringContaining("fast mode unavailable") }),
    );
    expect(useWsSessionStore.getState().sessions.s1.pendingCommandActions).toEqual([
      "runtime_overrides.set:model",
    ]);
  });

  it("queues a fast mode change made during an outage and applies it once confirmed", async () => {
    await connectInitializedThenDrop();
    const store = useWsSessionStore.getState();

    await store.setFastMode("s1", true);
    const waiting = useWsSessionStore.getState().sessions.s1;
    expect(waiting.queuedCommandActions).toEqual(["fast_mode.set"]);
    expect(waiting.fastMode).toBe(false);

    store.connect("s1");
    await tick();
    const ws = getWs();
    const sent = ws.sent
      .map((raw) => JSON.parse(raw) as { id: string; action: string; payload: unknown })
      .filter((envelope) => envelope.action === "fast_mode.set");
    expect(sent.map((envelope) => envelope.payload)).toEqual([{ session_id: "7", enabled: true }]);
    expect(useWsSessionStore.getState().sessions.s1.fastMode).toBe(false);

    ws.simulateMessage({
      domain: "session",
      action: "fast_mode.set.ok",
      ref: sent[0].id,
      payload: { enabled: true },
    });
    const session = useWsSessionStore.getState().sessions.s1;
    expect(session.fastMode).toBe(true);
    expect(session.pendingCommandActions).toEqual([]);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("replays a Codex model change before the effort chosen after it", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const first = getWs();
    first.simulateMessage({
      domain: "session",
      action: "initialized",
      payload: { session_id: "7", provider: "codex_cli", model: "gpt-a" },
    });
    first.readyState = MockWebSocket.CLOSED;
    first.fireEvent("close", { code: 1006 });

    // As online: the model switch loads that model's remembered effort, then
    // the explicit effort replaces it, so the session ends on gpt-5.6 / xhigh.
    store.queueRuntimeOverride("s1", { model: "gpt-5.6-sol" });
    store.queueRuntimeOverride("s1", { thinking_effort: "xhigh" });

    store.connect("s1");
    await tick();
    const overrides = getWs()
      .sent.map((raw) => JSON.parse(raw) as { action: string; payload: Record<string, unknown> })
      .filter((envelope) => envelope.action === "runtime_overrides.set")
      .map((envelope) => envelope.payload.runtime_overrides);
    expect(overrides).toEqual([{ model: "gpt-5.6-sol" }, { thinking_effort: "xhigh" }]);
  });

  it("never replays a Stop pressed while disconnected", async () => {
    await connectInitializedThenDrop();
    const store = useWsSessionStore.getState();

    store.interrupt("s1");
    expect(toastError).toHaveBeenCalledWith("Couldn't stop the agent", expect.anything());
    expect(useWsSessionStore.getState().sessions.s1.pendingCommandActions).toEqual([]);

    store.connect("s1");
    await tick();

    expect(sentActions(getWs())).not.toContain("session.interrupt");
  });

  it("replays a setting changed during an abnormal drop once the reconnect floor has passed", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();
    ws.simulateMessage({ domain: "session", action: "initialized", payload: { session_id: "7" } });
    vi.useFakeTimers();
    try {
      // The service went away: the browser reports a 1006, so the next retry
      // waits at least the rate-limit floor.
      ws.readyState = MockWebSocket.CLOSED;
      ws.fireEvent("close", { code: 1006 });
      store.setModel("s1", "opus", "claude-code");

      await vi.advanceTimersByTimeAsync(WS_RATE_LIMIT_RETRY_MS + 100);

      expect(getWs()).not.toBe(ws);
      expect(sentActions(getWs())).toContain("session.model.set");
      expect(toastError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps only the latest setting of each kind while disconnected", async () => {
    await connectInitializedThenDrop();
    const store = useWsSessionStore.getState();
    store.setModel("s1", "opus", "claude-code");
    store.setThinkingEffort("s1", "high");
    store.setModel("s1", "sonnet", "claude-code");
    expect(useWsSessionStore.getState().sessions.s1.queuedCommandActions).toEqual([
      "effort.set",
      "model.set",
    ]);

    store.connect("s1");
    await tick();

    const models = getWs()
      .sent.map((raw) => JSON.parse(raw) as { action: string; payload: { model?: string } })
      .filter((envelope) => envelope.action === "model.set")
      .map((envelope) => envelope.payload.model);
    expect(models).toEqual(["sonnet"]);
    expect(sentActions(getWs())).toContain("session.effort.set");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows a queued setting as waiting until it leaves with the reconnect", async () => {
    await connectInitializedThenDrop();
    const store = useWsSessionStore.getState();
    store.setPermissionMode("s1", "plan");
    const waiting = useWsSessionStore.getState().sessions.s1;
    expect(waiting.queuedCommandActions).toEqual(["mode.set"]);
    // No optimistic write: the chip keeps the backend-confirmed mode.
    expect(waiting.permissionMode).not.toBe("plan");

    store.connect("s1");
    await tick();

    const sent = useWsSessionStore.getState().sessions.s1;
    expect(sent.queuedCommandActions).toEqual([]);
    expect(sent.pendingCommandActions).toEqual(["mode.set"]);
  });

  it("presents a failed command by the command, not as a turn error", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();
    ws.simulateMessage({ domain: "session", action: "initialized", payload: { session_id: "7" } });

    store.interrupt("s1");
    expect(useWsSessionStore.getState().sessions.s1.pendingCommandActions).toEqual(["interrupt"]);
    const sent = JSON.parse(ws.sent.at(-1) ?? "{}") as { id: string; action: string };
    expect(sent.action).toBe("interrupt");
    const lifecycleBefore = useWsSessionStore.getState().sessions.s1.lifecycle;

    ws.simulateMessage({
      domain: "session",
      action: "error",
      ref: sent.id,
      payload: { code: "SDK_ERROR", message: "interrupt timed out" },
    });

    const session = useWsSessionStore.getState().sessions.s1;
    expect(toastError).toHaveBeenCalledWith("Couldn't stop the agent", {
      description: "interrupt timed out",
    });
    expect(session.blocks.some((block) => block.type === "error")).toBe(false);
    expect(session.lifecycle).toEqual(lifecycleBefore);
    expect(session.pendingCommandActions).toEqual([]);
  });

  it("presents a refused pause for sleep as a toast: the turn goes on", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();
    ws.simulateMessage({ domain: "session", action: "initialized", payload: { session_id: "7" } });
    useWsSessionStore.setState((state) => ({
      sessions: { ...state.sessions, s1: { ...state.sessions.s1, lifecycle: { phase: "active" } } },
    }));

    store.suspendForSleep("s1");
    const sent = JSON.parse(ws.sent.at(-1) ?? "{}") as { id: string; action: string };
    expect(sent.action).toBe("suspend");

    // The order the backend sends: the gate it closed (an event), then the
    // outcome, the only reply correlated to the command.
    ws.simulateMessage({
      domain: "session",
      action: "gate.closed",
      payload: { session_id: "7", reason: "sleep" },
    });
    ws.simulateMessage({
      domain: "session",
      action: "error",
      ref: sent.id,
      payload: { code: "SDK_ERROR", message: "The agent did not pause for sleep: refused" },
    });

    const session = useWsSessionStore.getState().sessions.s1;
    expect(toastError).toHaveBeenCalledWith("Agent kept running into sleep", {
      description: "The agent did not pause for sleep: refused",
    });
    expect(session.blocks.some((block) => block.type === "error")).toBe(false);
    expect(session.lifecycle).toEqual({ phase: "active" });
  });

  it("settles a pause for sleep on its acknowledgement, without a toast", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();
    ws.simulateMessage({ domain: "session", action: "initialized", payload: { session_id: "7" } });

    store.suspendForSleep("s1");
    const sent = JSON.parse(ws.sent.at(-1) ?? "{}") as { id: string };
    expect(useWsSessionStore.getState().sessions.s1.pendingCommandActions).toEqual(["suspend"]);
    ws.simulateMessage({
      domain: "session",
      action: "acknowledged",
      ref: sent.id,
      payload: { action: "suspend" },
    });

    expect(useWsSessionStore.getState().sessions.s1.pendingCommandActions).toEqual([]);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("settles a Stop once the status book reports the session stopped, then allows another", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();
    ws.simulateMessage({ domain: "session", action: "initialized", payload: { session_id: "7" } });

    store.interrupt("s1");
    store.interrupt("s1");
    expect(sentActions(ws).filter((action) => action === "session.interrupt")).toHaveLength(1);

    store.settleInterrupt("s1");
    expect(useWsSessionStore.getState().sessions.s1.pendingCommandActions).toEqual([]);
    store.interrupt("s1");
    expect(sentActions(ws).filter((action) => action === "session.interrupt")).toHaveLength(2);
  });

  it("treats a Stop with nothing running as done, without an error toast", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();
    ws.simulateMessage({ domain: "session", action: "initialized", payload: { session_id: "7" } });

    store.interrupt("s1");
    const sent = JSON.parse(ws.sent.at(-1) ?? "{}") as { id: string };
    ws.simulateMessage({
      domain: "session",
      action: "error",
      ref: sent.id,
      payload: { code: "NOTHING_TO_STOP", message: "Session not active" },
    });

    expect(toastError).not.toHaveBeenCalled();
    expect(useWsSessionStore.getState().sessions.s1.pendingCommandActions).toEqual([]);
  });

  it("reports a Stop sent while the agent is still starting: it was not stopped", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();
    ws.simulateMessage({ domain: "session", action: "initialized", payload: { session_id: "7" } });

    store.interrupt("s1");
    const sent = JSON.parse(ws.sent.at(-1) ?? "{}") as { id: string };
    const message = "The agent is still starting. Stop it again once it runs.";
    ws.simulateMessage({
      domain: "session",
      action: "error",
      ref: sent.id,
      payload: { code: "AGENT_STARTING", message },
    });

    expect(toastError).toHaveBeenCalledWith(
      "Couldn't stop the agent",
      expect.objectContaining({ description: message }),
    );
  });

  it("reports a queued setting as unsent once automatic reconnects give up", async () => {
    vi.useFakeTimers();
    try {
      // Its own session: the reconnect registry stays paused for this key.
      const store = useWsSessionStore.getState();
      store.connect("s-gives-up");
      await vi.advanceTimersByTimeAsync(0);
      const ws = getWs();
      ws.simulateMessage({
        domain: "session",
        action: "initialized",
        payload: { session_id: "8" },
      });
      MockWebSocket.failOpen = true;
      ws.readyState = MockWebSocket.CLOSED;
      ws.fireEvent("close", { code: 1006 });
      useWsSessionStore.getState().setModel("s-gives-up", "opus", "claude-code");
      // Every retry fails, as long as the service stays down.
      await vi.advanceTimersByTimeAsync(AUTO_RECONNECT_TIMEOUT_MS / 2);
      expect(toastError).not.toHaveBeenCalled();
      expect(useWsSessionStore.getState().sessions["s-gives-up"].queuedCommandActions).toEqual([
        "model.set",
      ]);

      await vi.advanceTimersByTimeAsync(AUTO_RECONNECT_TIMEOUT_MS);
      expect(toastError).toHaveBeenCalledWith("Couldn't switch model", expect.anything());
      const session = useWsSessionStore.getState().sessions["s-gives-up"];
      expect(session.queuedCommandActions).toEqual([]);
      expect(session.pendingCommandActions).toEqual([]);

      // Reconnects are paused for a manual retry: a new setting is refused at
      // once, not parked until someone presses "Retry now".
      toastError.mockClear();
      useWsSessionStore.getState().setThinkingEffort("s-gives-up", "high");
      expect(toastError).toHaveBeenCalledWith("Couldn't change thinking effort", expect.anything());
      expect(useWsSessionStore.getState().sessions["s-gives-up"].queuedCommandActions).toEqual([]);

      // "Retry now" resumes automatic reconnects even though the service is
      // still down: a setting waits for them again.
      forceReconnectAll({ bypassManualPause: true });
      await vi.advanceTimersByTimeAsync(0);
      toastError.mockClear();
      useWsSessionStore.getState().setPermissionMode("s-gives-up", "plan");
      expect(toastError).not.toHaveBeenCalled();
      expect(useWsSessionStore.getState().sessions["s-gives-up"].queuedCommandActions).toEqual([
        "mode.set",
      ]);
    } finally {
      MockWebSocket.failOpen = false;
      vi.useRealTimers();
    }
  });

  it("warns about a replayed setting whose outcome a later drop leaves unknown", async () => {
    await connectInitializedThenDrop();
    const store = useWsSessionStore.getState();
    store.setModel("s1", "opus", "claude-code");
    store.connect("s1");
    await tick();
    expect(sentActions(getWs())).toContain("session.model.set");

    const ws = getWs();
    ws.readyState = MockWebSocket.CLOSED;
    ws.fireEvent("close");

    expect(toastWarning).toHaveBeenCalledWith("Couldn't switch model", expect.anything());
  });

  it("settles a command on its correlated success reply and still applies it", async () => {
    const store = useWsSessionStore.getState();
    store.connect("s1");
    await tick();
    const ws = getWs();
    ws.simulateMessage({ domain: "session", action: "initialized", payload: { session_id: "7" } });

    store.setThinkingEffort("s1", "high");
    const sent = JSON.parse(ws.sent.at(-1) ?? "{}") as { id: string };
    expect(useWsSessionStore.getState().sessions.s1.pendingCommandActions).toEqual(["effort.set"]);
    ws.simulateMessage({
      domain: "session",
      action: SESSION_ACTION.effortsetok,
      ref: sent.id,
      payload: { thinking_effort: "high" },
    });

    const session = useWsSessionStore.getState().sessions.s1;
    expect(session.pendingCommandActions).toEqual([]);
    expect(session.currentThinkingEffort).toBe("high");
  });

  it("delivers a prompt sent during the reconnect gap instead of dropping it", async () => {
    await connectInitializedThenDrop();
    const store = useWsSessionStore.getState();

    store.sendPrompt("s1", "hello from the gap");
    // No competing optimistic block is created while the transport is down.
    const blocks = useWsSessionStore.getState().sessions.s1.blocks;
    expect(blocks).toHaveLength(0);

    store.connect("s1");
    await tick();

    // The prompt reaches the backend after reconnect with its stable identity.
    // (toContain also fails when no prompt.send envelope was sent at all).
    const promptRaw = getWs().sent.find((raw) => raw.includes("prompt.send"));
    expect(promptRaw).toContain("hello from the gap");
    const prompt = JSON.parse(promptRaw ?? "{}");
    expect(prompt.payload.message_uuid).toEqual(expect.any(String));
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

    store.setModel("s1", "opus", "claude-code");
    store.connect("s1");
    await tick();

    // A single assertion covers both presence and relative order.
    const actions = sentActions(getWs());
    const replayThenFlush = actions.filter(
      (action) => action === "session.init" || action === "session.model.set",
    );
    expect(replayThenFlush).toEqual(["session.init", "session.model.set"]);
  });

  it("sendRequest during the gap resolves with the reply that arrives after reconnect", async () => {
    await connectInitializedThenDrop();
    const store = useWsSessionStore.getState();

    const envelope = createSessionEnvelope("retry_worktree_setup", { feature_id: 42 });
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

    store.disconnect("s1");
    expect(useWsSessionStore.getState().sessions.s1).toBeUndefined();
    store.connect("s1");
    await tick();
    expect(sentActions(getWs())).not.toContain("session.interrupt");
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
      const envelope = createSessionEnvelope("retry_worktree_setup", { feature_id: 42 });
      const pending = store.sendRequest("s1", envelope);

      // 10s elapse with the socket still down: the request times out and its
      // envelope must leave the queue instead of lingering as a stale flush.
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(pending).resolves.toBeNull();

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
      createSessionEnvelope("retry_worktree_setup", { feature_id: 42 }),
    );

    // The close lands: the pending-request sweep resolves the promise null
    // and must take the matching queued envelope with it.
    ws.fireEvent("close");
    await expect(pending).resolves.toBeNull();

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
      createSessionEnvelope("retry_worktree_setup", { feature_id: 42 }),
    );

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
      createSessionEnvelope("retry_worktree_setup", { feature_id: 42 }),
    );
    store.disconnect("s1");

    // Resolves now instead of hanging until the 10s timeout after teardown.
    await expect(pending).resolves.toBeNull();
  });
});
