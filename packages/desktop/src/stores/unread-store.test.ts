// @vitest-environment happy-dom
/**
 * Unread sidebar dot: store/hook unit behaviour plus the turn-completion path
 * that flags a feature unread when the agent finishes off-screen.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hash history: `isViewingFeature` parses `window.location.hash`, so drive the
// route by stubbing the hash (`pathname` is always `/` under hash history).
function setRoute(pathname: string): void {
  Object.defineProperty(window, "location", {
    value: { hash: pathname === "/" ? "" : `#${pathname}` },
    writable: true,
  });
}

import { queryClient } from "@/lib/queryClient";
import { getListFeaturesQueryKey, type Feature } from "@/api/generated";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { useIsFeatureUnread, useMarkFeatureRead, useUnreadStore } from "@/stores/unread-store";

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

function seedFeature(id: number, projectId: number): void {
  queryClient.setQueryData<Feature[]>(getListFeaturesQueryKey({ project_id: projectId }), [
    { id, project_id: projectId, title: "F" } as Feature,
  ]);
}

function emitStatus(ws: MockWebSocket | undefined, payload: Record<string, unknown>): void {
  ws?.simulateMessage({ domain: "app", action: "session_status.update", payload });
}

beforeEach(() => {
  useUnreadStore.setState({ byFeature: {} });
  setRoute("/other");
});

afterEach(() => {
  useSessionStatusStore.getState().disconnect();
  useSessionStatusStore.setState({ bySession: {}, ws: null, isConnected: false });
  MockWebSocket.reset();
  queryClient.clear();
  vi.unstubAllGlobals();
});

describe("unread store", () => {
  it("markUnread / markRead toggle the per-feature flag", () => {
    useUnreadStore.getState().markUnread(7);
    expect(useUnreadStore.getState().byFeature[7]).toBe(true);
    useUnreadStore.getState().markRead(7);
    expect(useUnreadStore.getState().byFeature[7]).toBeUndefined();
  });

  it("markUnread is a no-op (stable state) when already unread", () => {
    useUnreadStore.getState().markUnread(7);
    const before = useUnreadStore.getState().byFeature;
    useUnreadStore.getState().markUnread(7);
    expect(useUnreadStore.getState().byFeature).toBe(before);
  });

  it("useIsFeatureUnread reflects only its own feature", () => {
    const { result } = renderHook(() => useIsFeatureUnread(7));
    expect(result.current).toBe(false);
    act(() => useUnreadStore.getState().markUnread(7));
    expect(result.current).toBe(true);
    act(() => useUnreadStore.getState().markUnread(8));
    expect(result.current).toBe(true); // unaffected by another feature
    act(() => useUnreadStore.getState().markRead(7));
    expect(result.current).toBe(false);
  });

  it("useMarkFeatureRead clears the flag when the conversation opens", () => {
    useUnreadStore.getState().markUnread(7);
    renderHook(() => useMarkFeatureRead(7));
    expect(useUnreadStore.getState().byFeature[7]).toBeUndefined();
  });
});

describe("turn completion → unread", () => {
  it("flags a feature unread when the agent finishes off-screen", () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    seedFeature(1, 2);
    useSessionStatusStore.getState().connect();
    const ws = MockWebSocket.instances[0];

    emitStatus(ws, { session_id: 10, feature_id: 1, status: "agent", kind: null, seq: 1 });
    emitStatus(ws, { session_id: 10, feature_id: 1, status: "idle", kind: null, seq: 2 });

    expect(useUnreadStore.getState().byFeature[1]).toBe(true);
  });

  it("does NOT flag unread when the user is viewing that feature", () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    setRoute("/ws-session/ws-feature-1");
    seedFeature(1, 2);
    useSessionStatusStore.getState().connect();
    const ws = MockWebSocket.instances[0];

    emitStatus(ws, { session_id: 10, feature_id: 1, status: "agent", kind: null, seq: 1 });
    emitStatus(ws, { session_id: 10, feature_id: 1, status: "idle", kind: null, seq: 2 });

    expect(useUnreadStore.getState().byFeature[1]).toBeUndefined();
  });
});
