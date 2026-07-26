import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { createSessionEntry } from "@/stores/ws-session-types";
import { queryClient } from "@/lib/queryClient";
import { getListFeaturesQueryKey, type Feature } from "@/api/generated";
import { handleAppEnvelope } from "@/stores/session-status-handlers";
import { transitionTurn } from "@/stores/ws-turn-lifecycle";
import { startTurnTiming } from "@/stores/ws-turn-timing";
import { getInvalidatePredicate } from "@/test-utils";
import { resetScheduleInvalidationForTest } from "@/lib/schedules/invalidate";

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
    useSessionStatusStore.getState().disconnect();
    useSessionStatusStore.setState({
      bySession: {},
      ws: null,
      isConnected: false,
      hasSnapshot: false,
    });
    useWsSessionStore.setState({ sessions: {} });
    MockWebSocket.reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
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
