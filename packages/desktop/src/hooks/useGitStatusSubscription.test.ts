// @vitest-environment happy-dom
/**
 * Lifecycle test for `useGitStatusSubscription`.
 *
 * The hook is a thin coordinator: when the WS is OPEN and a featureId is
 * supplied, send `app/subscribe.git_status`; on unmount or feature change
 * send `app/unsubscribe.git_status`. We mock `useSessionStatusStore` with a
 * synchronous shim so renderHook can drive both selectors deterministically.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

interface FakeStoreState {
  ws: WebSocket | null;
  isConnected: boolean;
}

interface FakeGitStatusState {
  watcherEpoch: Record<number, number>;
}

const storeState: FakeStoreState = { ws: null, isConnected: false };
const gitStatusState: FakeGitStatusState = { watcherEpoch: {} };

vi.mock("@/stores/session-status-store", () => ({
  useSessionStatusStore: <T>(selector: (s: FakeStoreState) => T): T => selector(storeState),
}));

vi.mock("@/stores/useGitStatusStore", () => ({
  useGitStatusStore: <T>(selector: (s: FakeGitStatusState) => T): T => selector(gitStatusState),
  selectGitWatcherEpoch:
    (featureId: number | null | undefined) =>
    (state: FakeGitStatusState): number =>
      featureId == null ? 0 : (state.watcherEpoch[featureId] ?? 0),
}));

import { useGitStatusSubscription } from "./useGitStatusSubscription";

function makeFakeWs(
  readyState: number = WebSocket.OPEN,
): WebSocket & { send: ReturnType<typeof vi.fn> } {
  // Minimal WebSocket-shaped fake. We only exercise `send` and `readyState`.
  return {
    send: vi.fn(),
    readyState,
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onclose: null,
    onerror: null,
    onmessage: null,
    onopen: null,
    binaryType: "blob",
    bufferedAmount: 0,
    extensions: "",
    protocol: "",
    url: "ws://test",
    CLOSED: WebSocket.CLOSED,
    CLOSING: WebSocket.CLOSING,
    CONNECTING: WebSocket.CONNECTING,
    OPEN: WebSocket.OPEN,
  } as unknown as WebSocket & { send: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  storeState.ws = null;
  storeState.isConnected = false;
  gitStatusState.watcherEpoch = {};
});

describe("useGitStatusSubscription", () => {
  it("sends subscribe.git_status on mount when WS is OPEN", () => {
    const ws = makeFakeWs();
    storeState.ws = ws;
    storeState.isConnected = true;

    renderHook(() => useGitStatusSubscription(7));

    expect(ws.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(ws.send.mock.calls[0][0] as string);
    expect(sent.domain).toBe("app");
    expect(sent.action).toBe("subscribe.git_status");
    expect(sent.payload).toEqual({ feature_id: 7 });
  });

  it("sends unsubscribe.git_status on unmount", () => {
    const ws = makeFakeWs();
    storeState.ws = ws;
    storeState.isConnected = true;

    const { unmount } = renderHook(() => useGitStatusSubscription(7));
    expect(ws.send).toHaveBeenCalledTimes(1);

    unmount();
    expect(ws.send).toHaveBeenCalledTimes(2);
    const sent = JSON.parse(ws.send.mock.calls[1][0] as string);
    expect(sent.action).toBe("unsubscribe.git_status");
    expect(sent.payload).toEqual({ feature_id: 7 });
  });

  it("does nothing when featureId is null", () => {
    const ws = makeFakeWs();
    storeState.ws = ws;
    storeState.isConnected = true;

    const { unmount } = renderHook(() => useGitStatusSubscription(null));
    unmount();
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("does nothing when WS is not connected", () => {
    storeState.ws = null;
    storeState.isConnected = false;

    const { unmount } = renderHook(() => useGitStatusSubscription(1));
    unmount();
    // No WS to send on; nothing to assert beyond a clean lifecycle.
    expect(true).toBe(true);
  });

  it("does nothing when WS is connected but readyState is CLOSING", () => {
    const ws = makeFakeWs(WebSocket.CLOSING);
    storeState.ws = ws;
    // The store can briefly report `isConnected=true` while the socket is
    // already closing — the hook must guard with `readyState`.
    storeState.isConnected = true;

    const { unmount } = renderHook(() => useGitStatusSubscription(1));
    unmount();
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("re-subscribes when watcherEpoch bumps (worktree.created/ready arrived)", () => {
    // Reproduces the worktree-creation flicker: the initial subscribe binds
    // the backend watcher to the project path because `worktree_path` is not
    // yet set. The WS envelope handler bumps `watcherEpoch[featureId]` when
    // it sees `worktree.created`/`worktree.ready` — and including the epoch
    // in the effect deps forces a re-subscribe so the backend re-resolves
    // to the freshly-created path. The epoch is driven by the WS envelope
    // directly so ws-session rebinds without relying on local status fields.
    const ws = makeFakeWs();
    storeState.ws = ws;
    storeState.isConnected = true;

    const { rerender } = renderHook(() => useGitStatusSubscription(7));
    expect(ws.send).toHaveBeenCalledTimes(1);

    gitStatusState.watcherEpoch = { 7: 1 };
    rerender();

    // Should have: subscribe(7), unsubscribe(7) [cleanup], subscribe(7).
    expect(ws.send).toHaveBeenCalledTimes(3);
    const actions = ws.send.mock.calls.map((c) => JSON.parse(c[0] as string).action);
    expect(actions).toEqual([
      "subscribe.git_status",
      "unsubscribe.git_status",
      "subscribe.git_status",
    ]);
  });

  it("re-subscribes when featureId changes", () => {
    const ws = makeFakeWs();
    storeState.ws = ws;
    storeState.isConnected = true;

    const { rerender } = renderHook(({ id }: { id: number }) => useGitStatusSubscription(id), {
      initialProps: { id: 1 } as { id: number },
    });
    rerender({ id: 2 });

    // Should have: subscribe(1), unsubscribe(1) [cleanup], subscribe(2).
    expect(ws.send).toHaveBeenCalledTimes(3);
    const actions = ws.send.mock.calls.map((c) => JSON.parse(c[0] as string).action);
    expect(actions).toEqual([
      "subscribe.git_status",
      "unsubscribe.git_status",
      "subscribe.git_status",
    ]);
    const featureIds = ws.send.mock.calls.map((c) => JSON.parse(c[0] as string).payload.feature_id);
    expect(featureIds).toEqual([1, 1, 2]);
  });
});
