import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStatusStore } from "./session-status-store";
import { useWsSessionStore } from "./ws-session-store";
import { setDeltaFlushScheduler } from "./ws-delta-scheduler";
import { updateSession } from "./ws-session-types";
import { resetServerClock } from "@/lib/server-clock";
import { notifyAgentNeedsInput } from "@/lib/notify-agent-done";
import { queryClient } from "@/lib/queryClient";
import { getListFeaturesQueryKey, type Feature } from "@/api/generated";

vi.mock("@/lib/worktreeQueries", () => ({ invalidateWorktreeQueries: vi.fn() }));
vi.mock("@/lib/notify-agent-done", () => ({
  isViewingFeature: vi.fn(() => false),
  notifyAgentDone: vi.fn(),
  notifyAgentNeedsInput: vi.fn(),
}));

/** One mock for both sockets: the app socket and the per-feature session socket. */
class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.OPEN;
  sent: string[] = [];
  private listeners: Record<string, Array<(event: unknown) => void>> = {};

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  addEventListener(event: string, cb: (event: unknown) => void): void {
    (this.listeners[event] ??= []).push(cb);
  }

  removeEventListener(): void {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  fire(event: string, data?: unknown): void {
    for (const cb of this.listeners[event] ?? []) cb(data ?? {});
  }

  emit(envelope: { domain: string; action: string; payload: unknown }): void {
    this.fire("message", { data: JSON.stringify({ id: "srv", ...envelope }) });
  }
}

const SESSION_DB_ID = 7;
const FEATURE_ID = 70;

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function assistantText(text: string): unknown {
  return {
    blocks: [{ type: "assistant", message: { content: [{ type: "text", text }] } }],
  };
}

function appStatus(appWs: MockWebSocket, seq: number, status: string, extra = {}): void {
  appWs.emit({
    domain: "app",
    action: "session_status.update",
    payload: { session_id: SESSION_DB_ID, feature_id: FEATURE_ID, status, seq, ...extra },
  });
}

/** An initialized conversation on its feature socket, plus a connected app socket. */
async function openConversation(): Promise<{ featureWs: MockWebSocket; appWs: MockWebSocket }> {
  useWsSessionStore.getState().connect("s1");
  const featureWs = MockWebSocket.instances.at(-1)!;
  // Only the feature socket opens: the app socket's open handler needs a DOM.
  featureWs.fire("open");
  await tick();
  featureWs.emit({ domain: "session", action: "initialized", payload: { session_id: "srv-1" } });
  useWsSessionStore.setState((state) =>
    updateSession(state, "s1", { sessionDbId: SESSION_DB_ID, featureId: FEATURE_ID }),
  );
  useSessionStatusStore.getState().connect();
  const appWs = MockWebSocket.instances.at(-1)!;
  return { featureWs, appWs };
}

function session() {
  return useWsSessionStore.getState().sessions.s1;
}

function turnSummaries(): number {
  return session().blocks.filter((block) => block.type === "turn_summary").length;
}

describe("session state across the app and feature sockets", () => {
  beforeEach(() => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    MockWebSocket.instances = [];
    useWsSessionStore.setState({ sessions: {} });
    vi.mocked(notifyAgentNeedsInput).mockClear();
  });

  afterEach(() => {
    for (const sessionId of Object.keys(useWsSessionStore.getState().sessions)) {
      useWsSessionStore.getState().disconnect(sessionId);
    }
    useSessionStatusStore.getState().disconnect();
    useSessionStatusStore.setState({
      bySession: {},
      ws: null,
      isConnected: false,
      hasSnapshot: false,
      epoch: null,
      snapshotSeq: 0,
    });
    setDeltaFlushScheduler((flush) => flush());
    queryClient.clear();
    resetServerClock();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("ends the turn once when the app socket goes idle before the feature socket ends it", async () => {
    const { featureWs, appWs } = await openConversation();
    appStatus(appWs, 1, "agent");
    expect(session().lifecycle).toEqual({ phase: "active" });

    appStatus(appWs, 2, "idle");
    featureWs.emit({ domain: "session", action: "ended", payload: { reason: "turn_complete" } });

    expect(session().lifecycle).toEqual({ phase: "terminal", reason: "completed" });
    expect(turnSummaries()).toBe(1);
    expect(session().blocks.at(-1)?.type).toBe("turn_summary");
  });

  it("ends the turn once when the feature socket ends it before the app socket goes idle", async () => {
    const { featureWs, appWs } = await openConversation();
    appStatus(appWs, 1, "agent");

    featureWs.emit({ domain: "session", action: "ended", payload: { reason: "turn_complete" } });
    appStatus(appWs, 2, "idle");

    expect(session().lifecycle).toEqual({ phase: "terminal", reason: "completed" });
    expect(turnSummaries()).toBe(1);
  });

  // Known ordering gap: the app socket's idle ends the turn while the feature
  // socket still buffers deltas. The turn summary lands before the last text,
  // the flushed text flips the turn back to active, and `ended` appends a
  // second summary. Kept as a failing expectation until status changes are
  // applied behind the pending deltas.
  it.fails("keeps the turn summary after text still buffered when the app socket goes idle", async () => {
    const { featureWs, appWs } = await openConversation();
    appStatus(appWs, 1, "agent");
    const pendingFlushes: Array<() => void> = [];
    setDeltaFlushScheduler((flush) => pendingFlushes.push(flush));

    featureWs.emit({ domain: "session", action: "message", payload: assistantText("last words") });
    appStatus(appWs, 2, "idle");
    for (const flush of pendingFlushes.splice(0)) flush();
    featureWs.emit({ domain: "session", action: "ended", payload: { reason: "turn_complete" } });

    const types = session().blocks.map((block) => block.type);
    expect(types.filter((type) => type === "turn_summary")).toHaveLength(1);
    expect(types.at(-1)).toBe("turn_summary");
  });

  it("notifies once when a snapshot shows a session newly awaiting the user", async () => {
    const feature = { id: FEATURE_ID, title: "Plan work", project_id: 1 } as Feature;
    queryClient.setQueryData(getListFeaturesQueryKey({ project_id: 1 }), [feature]);
    const { appWs } = await openConversation();
    const snapshot = (seq: number): void =>
      appWs.emit({
        domain: "app",
        action: "session_status.snapshot",
        payload: {
          seq,
          states: {
            [SESSION_DB_ID]: { feature_id: FEATURE_ID, status: "question", kind: "permission" },
          },
        },
      });

    snapshot(1);
    snapshot(2);

    expect(notifyAgentNeedsInput).toHaveBeenCalledTimes(1);
    expect(notifyAgentNeedsInput).toHaveBeenCalledWith(
      expect.objectContaining({ featureId: FEATURE_ID, featureTitle: "Plan work" }),
    );
    expect(session().lifecycle).toEqual({ phase: "paused", reason: "permission" });
  });
});
