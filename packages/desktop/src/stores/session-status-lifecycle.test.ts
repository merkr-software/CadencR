import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { createSessionEntry } from "@/stores/ws-session-types";
import { queryClient } from "@/lib/queryClient";
import { handleAppEnvelope } from "@/stores/session-status-handlers";
import { transitionTurn } from "@/stores/ws-turn-lifecycle";
import { startTurnTiming } from "@/stores/ws-turn-timing";
import { getInvalidatePredicate } from "@/test-utils";

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
    useSessionStatusStore.setState({ bySession: {}, ws: null, isConnected: false });
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

  it("invalidates editor read caches when file watcher events arrive", () => {
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();

    const handled = handleAppEnvelope("editor", "file_tree.changed", {
      project_path: "/workspace",
    });

    expect(handled).toBe(true);
    const predicate = getInvalidatePredicate(invalidateSpy.mock.calls[0]?.[0]);
    expect(predicate({ queryKey: ["/api/editor/read", { file_path: "a.ts" }] })).toBe(true);
    expect(predicate({ queryKey: ["/api/editor/tree-all", { project_id: 1 }] })).toBe(true);
    expect(predicate({ queryKey: ["/api/sessions"] })).toBe(false);
    invalidateSpy.mockRestore();
  });
});
