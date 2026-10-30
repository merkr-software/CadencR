import { updateQuestionDraft, useQuestionDraftStore } from "./question-drafts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { installSessionIntegration } from "@/lib/session-integration";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { createSessionEntry } from "@/stores/ws-session-types";
import { queryClient } from "@/lib/queryClient";
import { getListFeaturesQueryKey, type Feature } from "@/api/generated";
import { handleAppEnvelope } from "@/stores/session-status-handlers";
import { transitionTurn } from "@/stores/ws-turn-lifecycle";
import { startTurnTiming } from "@/stores/ws-turn-timing";
import { getInvalidatePredicate } from "@/test-utils";
import { resetScheduleInvalidationForTest } from "@/lib/schedules/invalidate";
import { resetServerClock } from "@/lib/server-clock";

class MockWebSocket {
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = 1;
  private listeners: Record<string, Array<(event: unknown) => void>> = {};

  constructor(_url: string, _protocols?: string | string[]) {
    MockWebSocket.instances.push(this);
  }

  addEventListener(event: string, cb: (event: unknown) => void): void {
    (this.listeners[event] ??= []).push(cb);
  }

  send(_data: string): void {}

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  simulateMessage(envelope: { domain: string; action: string; payload: unknown }): void {
    for (const cb of this.listeners.message ?? []) {
      cb({ data: JSON.stringify({ id: "app-test", ...envelope }) });
    }
  }

  static reset(): void {
    MockWebSocket.instances = [];
  }
}

describe("session status lifecycle sync", () => {
  afterEach(() => {
    useQuestionDraftStore.setState({ drafts: new Map() });
    useSessionStatusStore.getState().disconnect();
    useSessionStatusStore.setState({
      bySession: {},
      connectionEpoch: 0,
      isConnected: false,
      hasSnapshot: false,
      epoch: null,
      snapshotSeq: 0,
    });
    useWsSessionStore.setState({ sessions: {} });
    resetServerClock();
    MockWebSocket.reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(["update", "snapshot"])(
    "reconciles offscreen drafts using confirmed %s identities",
    (mode) => {
      vi.stubGlobal("WebSocket", MockWebSocket);
      useSessionStatusStore.setState({ bySession: {}, snapshotSeq: 0, epoch: null });
      useSessionStatusStore.getState().connect();
      const ws = MockWebSocket.instances.at(-1)!;
      const emit = (requestId: string, seq: number) =>
        ws.simulateMessage({
          domain: "app",
          action: "session_status.update",
          payload: {
            session_id: 7,
            feature_id: 7,
            status: "question",
            kind: "question",
            request_id: requestId,
            seq,
          },
        });
      emit("old", 1);
      updateQuestionDraft({ sessionId: 7, requestId: "new" }, (draft) => ({
        ...draft,
        freeText: "ahead of app socket",
      }));
      emit("old", 2);
      expect(useQuestionDraftStore.getState().drafts.get(7)?.draft.freeText).toBe(
        "ahead of app socket",
      );
      emit("new", 3);
      // A stale snapshot must preserve the newer status and draft.
      ws.simulateMessage({
        domain: "app",
        action: "session_status.snapshot",
        payload: { states: {}, seq: 2 },
      });
      expect(useQuestionDraftStore.getState().drafts.has(7)).toBe(true);
      if (mode === "snapshot") {
        ws.simulateMessage({
          domain: "app",
          action: "session_status.snapshot",
          payload: { states: {}, seq: 4 },
        });
      } else {
        ws.simulateMessage({
          domain: "app",
          action: "session_status.update",
          payload: { session_id: 7, feature_id: 7, status: "idle", seq: 4 },
        });
      }
      expect(useQuestionDraftStore.getState().drafts.has(7)).toBe(false);
    },
  );

  it("does not clear a newer mounted gate when the older app gate closes", () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    const session = createSessionEntry();
    session.sessionDbId = 7;
    session.pendingRequestId = "new";
    session.pendingQuestions = [{ question: "New gate" }];
    useWsSessionStore.setState({ sessions: { s1: session } });
    useSessionStatusStore.setState({
      bySession: {
        7: { status: "question", kind: "question", requestId: "old", featureId: 7, seq: 1 },
      },
      snapshotSeq: 0,
    });
    updateQuestionDraft({ sessionId: 7, requestId: "new" }, (draft) => ({
      ...draft,
      freeText: "keep",
    }));
    useSessionStatusStore.getState().connect();
    MockWebSocket.instances.at(-1)!.simulateMessage({
      domain: "app",
      action: "session_status.update",
      payload: { session_id: 7, feature_id: 7, status: "agent", seq: 2 },
    });
    expect(useWsSessionStore.getState().sessions.s1.pendingRequestId).toBe("new");
    expect(useQuestionDraftStore.getState().drafts.get(7)?.draft.freeText).toBe("keep");
  });

  it("does not restart active turn timing when status confirms an in-progress prompt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    vi.stubGlobal("WebSocket", MockWebSocket);

    const session = createSessionEntry();
    session.sessionDbId = 10;
    session.lifecycle = transitionTurn(session.lifecycle, { type: "prompt_sent" });
    session.turnTiming = startTurnTiming(1_000);
    session.blocks = [
      {
        id: "user-1",
        type: "user_message",
        content: "steer now",
        isError: false,
      },
    ];
    useWsSessionStore.setState({ sessions: { s1: session } });
    useSessionStatusStore.setState({
      bySession: { 10: { status: "idle", kind: null, featureId: 1, seq: 1 } },
    });

    useSessionStatusStore.getState().connect();
    const ws = MockWebSocket.instances.at(-1);
    expect(ws).toBeDefined();

    ws?.simulateMessage({
      domain: "app",
      action: "session_status.update",
      payload: {
        session_id: 10,
        feature_id: 1,
        status: "agent",
        kind: null,
        seq: 2,
      },
    });

    const updated = useWsSessionStore.getState().sessions.s1;
    expect(updated.turnTiming.startedAt).toBe(1_000);
    expect(updated.turnTiming.segmentStartedAt).toBe(1_000);
  });

  it("anchors a second device's turn timer to the server-stamped start", () => {
    vi.useFakeTimers();
    // Local clock is far ahead of the server-stamped turn start to prove the
    // timer uses the server value, not Date.now().
    vi.setSystemTime(100_000);
    vi.stubGlobal("WebSocket", MockWebSocket);

    const session = createSessionEntry();
    session.sessionDbId = 20;
    // Idle, no timing yet — exactly how a second device looks when it opens a
    // conversation the host is already running.
    useWsSessionStore.setState({ sessions: { s2: session } });
    useSessionStatusStore.setState({
      bySession: { 20: { status: "idle", kind: null, featureId: 2, seq: 1 } },
    });

    useSessionStatusStore.getState().connect();
    const ws = MockWebSocket.instances.at(-1);
    ws?.simulateMessage({
      domain: "app",
      action: "session_status.update",
      payload: {
        session_id: 20,
        feature_id: 2,
        status: "agent",
        kind: null,
        seq: 2,
        turn_started_at_ms: 42_000,
      },
    });

    const updated = useWsSessionStore.getState().sessions.s2;
    expect(updated.turnTiming.startedAt).toBe(42_000);
    expect(updated.turnTiming.segmentStartedAt).toBe(42_000);
  });

  it("re-anchors a conversation that first saw the turn through its own stream", () => {
    vi.useFakeTimers();
    vi.setSystemTime(50_000);
    vi.stubGlobal("WebSocket", MockWebSocket);

    // The feature socket's stream flipped the turn active first, so the timer
    // started at this device's first sight of it.
    const session = createSessionEntry();
    session.sessionDbId = 21;
    session.lifecycle = { phase: "active" };
    session.turnTiming = startTurnTiming(50_000);
    useWsSessionStore.setState({ sessions: { s21: session } });

    useSessionStatusStore.getState().connect();
    MockWebSocket.instances.at(-1)?.simulateMessage({
      domain: "app",
      action: "session_status.update",
      payload: {
        session_id: 21,
        feature_id: 2,
        status: "agent",
        seq: 1,
        turn_started_at_ms: 40_000,
      },
    });

    const updated = useWsSessionStore.getState().sessions.s21;
    expect(updated.lifecycle.phase).toBe("active");
    expect(updated.turnTiming.startedAt).toBe(40_000);
    expect(updated.turnTiming.segmentStartedAt).toBe(40_000);
  });

  it("observes the clock before unchanged updates re-anchor timing and preserves no-op identities", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    vi.stubGlobal("WebSocket", MockWebSocket);
    const session = {
      ...createSessionEntry(),
      sessionDbId: 21,
      lifecycle: { phase: "active" } as const,
      turnTiming: startTurnTiming(93_000),
    };
    useWsSessionStore.setState({ sessions: { s21: session } });
    const bySession = {
      21: { status: "agent", kind: null, featureId: 2, seq: 1, turnStartedAtMs: 93_000 },
    } as const;
    useSessionStatusStore.setState({ bySession });
    useSessionStatusStore.getState().connect();
    const ws = MockWebSocket.instances.at(-1)!;
    const payload = {
      session_id: 21,
      feature_id: 2,
      status: "agent",
      seq: 2,
      turn_started_at_ms: 93_000,
      server_now_ms: 103_000,
    };
    ws.simulateMessage({ domain: "app", action: "session_status.update", payload });
    expect(useSessionStatusStore.getState().bySession).toBe(bySession);
    const anchored = useWsSessionStore.getState().sessions;
    expect(anchored.s21.turnTiming.startedAt).toBe(90_000);
    ws.simulateMessage({
      domain: "app",
      action: "session_status.update",
      payload: { ...payload, seq: 3 },
    });
    expect(useSessionStatusStore.getState().bySession).toBe(bySession);
    expect(useWsSessionStore.getState().sessions).toBe(anchored);
  });

  it("anchors a conversation opened mid-turn to the turn start it already knows", () => {
    vi.useFakeTimers();
    vi.setSystemTime(90_000);
    useSessionStatusStore.setState({
      bySession: {
        22: { status: "agent", kind: null, featureId: 2, seq: 4, turnStartedAtMs: 30_000 },
      },
    });
    const session = createSessionEntry();
    useWsSessionStore.setState({ sessions: { s22: session } });

    // Hydrating from history: no status event arrives, the turn is mid-way.
    useWsSessionStore.getState().setPersistedState("s22", {
      blocks: [],
      lifecycle: { phase: "active" },
      sessionDbId: 22,
      featureId: 2,
    });

    expect(useWsSessionStore.getState().sessions.s22.turnTiming.startedAt).toBe(30_000);
  });

  it("measures the turn on the server clock, whatever this device's skew", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    vi.stubGlobal("WebSocket", MockWebSocket);
    const session = createSessionEntry();
    session.sessionDbId = 23;
    useWsSessionStore.setState({ sessions: { s23: session } });

    // The server runs 3s ahead of this device; its turn started 10s ago.
    useSessionStatusStore.getState().connect();
    MockWebSocket.instances.at(-1)?.simulateMessage({
      domain: "app",
      action: "session_status.snapshot",
      payload: {
        seq: 5,
        epoch: 1,
        server_now_ms: 103_000,
        states: {
          23: {
            session_id: 23,
            feature_id: 2,
            status: "agent",
            turn_started_at_ms: 93_000,
          },
        },
      },
    });

    expect(useWsSessionStore.getState().sessions.s23.turnTiming.startedAt).toBe(90_000);
  });

  it("replaces everything on a snapshot from a restarted server and ends its turns", () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    const session = createSessionEntry();
    session.sessionDbId = 24;
    session.lifecycle = { phase: "active" };
    useWsSessionStore.setState({ sessions: { s24: session } });
    // The old process had reached seq 80; the new one restarted from zero.
    useSessionStatusStore.setState({
      epoch: 1,
      bySession: { 24: { status: "agent", kind: null, featureId: 2, seq: 80 } },
    });

    useSessionStatusStore.getState().connect();
    MockWebSocket.instances.at(-1)?.simulateMessage({
      domain: "app",
      action: "session_status.snapshot",
      payload: { seq: 2, epoch: 2, states: {} },
    });

    const state = useSessionStatusStore.getState();
    expect(state.bySession).toEqual({});
    expect(state.epoch).toBe(2);
    expect(useWsSessionStore.getState().sessions.s24.lifecycle.phase).toBe("terminal");
  });

  it("leaves a local turn alone when the snapshot omits a session that was already idle", () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    const session = createSessionEntry();
    session.sessionDbId = 27;
    // This device just sent a prompt; the server's "agent" has not arrived yet.
    session.lifecycle = transitionTurn(session.lifecycle, { type: "prompt_sent" });
    useWsSessionStore.setState({ sessions: { s27: session } });
    useSessionStatusStore.setState({
      bySession: { 27: { status: "idle", kind: null, featureId: 2, seq: 3 } },
    });

    useSessionStatusStore.getState().connect();
    MockWebSocket.instances.at(-1)?.simulateMessage({
      domain: "app",
      action: "session_status.snapshot",
      payload: { seq: 4, states: {} },
    });

    expect(useWsSessionStore.getState().sessions.s27.lifecycle.phase).toBe("active");
  });

  it("ignores an update the snapshot already folded in", () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    useSessionStatusStore.getState().connect();
    const ws = MockWebSocket.instances.at(-1);
    ws?.simulateMessage({
      domain: "app",
      action: "session_status.snapshot",
      payload: { seq: 10, epoch: 1, states: {} },
    });

    // Buffered between subscribe and snapshot: its idle successor is folded in.
    ws?.simulateMessage({
      domain: "app",
      action: "session_status.update",
      payload: { session_id: 25, feature_id: 2, status: "agent", seq: 9, epoch: 1 },
    });
    expect(useSessionStatusStore.getState().bySession[25]).toBeUndefined();

    ws?.simulateMessage({
      domain: "app",
      action: "session_status.update",
      payload: { session_id: 25, feature_id: 2, status: "agent", seq: 11, epoch: 1 },
    });
    expect(useSessionStatusStore.getState().bySession[25]?.status).toBe("agent");
  });

  it("keeps a new turn start that arrives with an unchanged status", () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    useSessionStatusStore.setState({
      bySession: {
        26: { status: "agent", kind: null, featureId: 2, seq: 1, turnStartedAtMs: 1_000 },
      },
    });

    useSessionStatusStore.getState().connect();
    MockWebSocket.instances.at(-1)?.simulateMessage({
      domain: "app",
      action: "session_status.update",
      payload: {
        session_id: 26,
        feature_id: 2,
        status: "agent",
        seq: 2,
        turn_started_at_ms: 5_000,
      },
    });

    expect(useSessionStatusStore.getState().bySession[26]?.turnStartedAtMs).toBe(5_000);
  });

  it("clears a pending gate when the session leaves the question state", () => {
    vi.stubGlobal("WebSocket", MockWebSocket);

    const session = createSessionEntry();
    session.sessionDbId = 30;
    // Mirror of a gate that another device answered: this device still shows it.
    session.lifecycle = transitionTurn(session.lifecycle, { type: "permission_requested" });
    session.pendingPermission = {
      requestId: "req-1",
      toolName: "Bash",
      input: {},
      description: "",
      pattern: "",
      options: [],
    };
    session.pendingRequestId = "req-1";
    useWsSessionStore.setState({ sessions: { s3: session } });
    useSessionStatusStore.setState({
      bySession: { 30: { status: "question", kind: "permission", featureId: 3, seq: 1 } },
    });

    useSessionStatusStore.getState().connect();
    const ws = MockWebSocket.instances.at(-1);
    // Another device answered → backend broadcasts the session back to "agent".
    ws?.simulateMessage({
      domain: "app",
      action: "session_status.update",
      payload: { session_id: 30, feature_id: 3, status: "agent", kind: null, seq: 2 },
    });

    const updated = useWsSessionStore.getState().sessions.s3;
    expect(updated.pendingPermission).toBeNull();
    expect(updated.pendingRequestId).toBe("");
  });

  it("tracks the active gate request id from snapshots and updates", () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    useSessionStatusStore.getState().connect();

    MockWebSocket.instances.at(-1)?.simulateMessage({
      domain: "app",
      action: "session_status.snapshot",
      payload: {
        seq: 1,
        states: {
          31: {
            session_id: 31,
            feature_id: 3,
            status: "question",
            kind: "permission",
            request_id: "req-31",
          },
        },
      },
    });

    expect(useSessionStatusStore.getState().hasSnapshot).toBe(true);
    expect(useSessionStatusStore.getState().bySession[31]?.requestId).toBe("req-31");

    MockWebSocket.instances.at(-1)?.simulateMessage({
      domain: "app",
      action: "session_status.update",
      payload: {
        session_id: 31,
        feature_id: 3,
        status: "question",
        kind: "permission",
        request_id: "req-32",
        seq: 2,
      },
    });

    expect(useSessionStatusStore.getState().bySession[31]?.requestId).toBe("req-32");
  });

  it("invalidates editor content and tree caches when file watcher events arrive", () => {
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();

    const handled = handleAppEnvelope("editor", "file_tree.changed", {
      project_path: "/workspace",
    });

    expect(handled).toBe(true);
    const predicate = getInvalidatePredicate(invalidateSpy.mock.calls[0]?.[0]);
    expect(predicate({ queryKey: ["/api/editor/read", { file_path: "a.ts" }] })).toBe(true);
    expect(predicate({ queryKey: ["/api/editor/read-image", { file_path: "a.png" }] })).toBe(true);
    expect(predicate({ queryKey: ["/api/editor/tree", { project_id: 1 }] })).toBe(true);
    expect(predicate({ queryKey: ["/api/editor/tree-all", { project_id: 1 }] })).toBe(true);
    expect(predicate({ queryKey: ["/api/editor/tree-count", { project_id: 1 }] })).toBe(false);
    expect(predicate({ queryKey: ["/api/editor/search", { query: "a" }] })).toBe(true);
    expect(predicate({ queryKey: ["/api/sessions"] })).toBe(false);
    invalidateSpy.mockRestore();
  });

  it("refetches the feature and lists when an 'updated' feature_event arrives", () => {
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();

    const handled = handleAppEnvelope("app", "feature_event", {
      feature_id: 7,
      action: "updated",
    });

    expect(handled).toBe(true);
    // An auto-name reaches us as "updated": both the individual feature (open
    // header REST fallback) and every per-project list must refresh.
    const keys = invalidateSpy.mock.calls.map(
      (c) => (c[0] as { queryKey?: unknown[] } | undefined)?.queryKey?.[0],
    );
    expect(keys).toContain("/api/features/7");
    expect(keys).toContain("/api/features");
    invalidateSpy.mockRestore();
  });

  it("scopes a 'reordered' feature_event to the cached feature's project", () => {
    // Seed the per-project list cache so the handler can resolve the project.
    queryClient.setQueryData(getListFeaturesQueryKey({ project_id: 4, include_archived: true }), [
      { id: 7, project_id: 4 } as Feature,
    ]);
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();

    handleAppEnvelope("app", "feature_event", { feature_id: 7, action: "reordered" });

    // A new user message reshuffles only its own project's list and leaves the
    // title unchanged: scope to that project, skip the single-feature refetch.
    const call = invalidateSpy.mock.calls[0]?.[0] as { queryKey?: unknown[] } | undefined;
    expect(call?.queryKey?.[0]).toBe("/api/features");
    expect(call?.queryKey?.[1]).toEqual({ project_id: 4 });
    invalidateSpy.mockRestore();
    queryClient.clear();
  });

  it("falls back to all lists for a 'reordered' feature_event with no cached feature", () => {
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();

    handleAppEnvelope("app", "feature_event", { feature_id: 7, action: "reordered" });

    // Uncached (e.g. a collapsed project on another device): broad invalidation
    // with no single-feature refetch.
    const call = invalidateSpy.mock.calls[0]?.[0] as { queryKey?: unknown[] } | undefined;
    expect(call?.queryKey).toEqual(["/api/features"]);
    const keys = invalidateSpy.mock.calls.map(
      (c) => (c[0] as { queryKey?: unknown[] } | undefined)?.queryKey?.[0],
    );
    expect(keys).not.toContain("/api/features/7");
    invalidateSpy.mockRestore();
  });

  // Replaces a cache-shaped guess: the old code refetched after *any* canonical
  // user message whose arrival happened to coincide with an overdue cached
  // schedule, and never learned about a run whose conversation wasn't open.
  it("refetches only the schedule lists when a schedule_event arrives", () => {
    resetScheduleInvalidationForTest();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();

    const handled = handleAppEnvelope("app", "schedule_event", { schedule_id: 3 });

    expect(handled).toBe(true);
    // The param-less prefix — every per-conversation and per-project variant
    // hangs off it. The conversation lists are deliberately untouched: a run
    // that spawns one emits `Created` and a run into an existing one emits
    // `Reordered`, so invalidating here would just duplicate that, more broadly.
    const keys = invalidateSpy.mock.calls.map(
      (c) => (c[0] as { queryKey?: unknown[] } | undefined)?.queryKey?.[0],
    );
    expect(keys).toEqual(["/api/schedules"]);
    invalidateSpy.mockRestore();
  });

  // The scheduler fires up to MAX_RUNS_PER_TICK schedules per tick, and a
  // "Run now" click reaches the same invalidation twice — once from the
  // mutation, once from the broadcast echoing back.
  it("coalesces a burst of schedule_events into one refetch", () => {
    resetScheduleInvalidationForTest();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();

    for (let i = 0; i < 5; i++) {
      handleAppEnvelope("app", "schedule_event", { schedule_id: i });
    }

    // Leading edge only — a lone event is never delayed, and the rest collapse
    // into the trailing run after the settle window.
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    invalidateSpy.mockRestore();
  });

  it("refetches only the lists for a created/deleted feature_event", () => {
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();

    handleAppEnvelope("app", "feature_event", { feature_id: 7, action: "created" });

    // No single-feature refetch — create/delete only reshape the lists, and a
    // delete's per-feature fetch would 404.
    const keys = invalidateSpy.mock.calls.map(
      (c) => (c[0] as { queryKey?: unknown[] } | undefined)?.queryKey?.[0],
    );
    expect(keys).toContain("/api/features");
    expect(keys).not.toContain("/api/features/7");
    invalidateSpy.mockRestore();
  });
});

// Exercise the same explicit composition that production installs before mounting.
let disposeSessionIntegration: () => void;
beforeEach(() => {
  disposeSessionIntegration = installSessionIntegration();
});
afterEach(() => disposeSessionIntegration());
