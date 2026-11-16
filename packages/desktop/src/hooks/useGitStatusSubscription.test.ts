// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const { subscribeGitStatus, storeState, gitStatusState } = vi.hoisted(() => {
  const subscribeGitStatus = vi.fn<(featureId: number) => () => void>();
  return {
    subscribeGitStatus,
    storeState: { isConnected: false, connectionEpoch: 0, subscribeGitStatus },
    gitStatusState: { watcherEpoch: {} as Record<number, number> },
  };
});

vi.mock("@/stores/session-status-store", () => ({
  useSessionStatusStore: <T>(selector: (state: typeof storeState) => T): T => selector(storeState),
}));
vi.mock("@/stores/useGitStatusStore", () => ({
  useGitStatusStore: <T>(selector: (state: typeof gitStatusState) => T): T =>
    selector(gitStatusState),
  selectGitWatcherEpoch:
    (featureId: number | null | undefined) =>
    (state: typeof gitStatusState): number =>
      featureId == null ? 0 : (state.watcherEpoch[featureId] ?? 0),
}));

import { useGitStatusSubscription } from "./useGitStatusSubscription";

beforeEach(() => {
  subscribeGitStatus.mockReset();
  subscribeGitStatus.mockImplementation(() => vi.fn());
  storeState.isConnected = false;
  storeState.connectionEpoch = 0;
  gitStatusState.watcherEpoch = {};
});

describe("useGitStatusSubscription", () => {
  it("subscribes while connected and releases its subscription on unmount", () => {
    storeState.isConnected = true;
    const release = vi.fn();
    subscribeGitStatus.mockReturnValue(release);
    const { unmount } = renderHook(() => useGitStatusSubscription(7));
    expect(subscribeGitStatus).toHaveBeenCalledExactlyOnceWith(7);
    expect(release).not.toHaveBeenCalled();
    unmount();
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([null, undefined])("does not subscribe without a feature (%s)", (featureId) => {
    storeState.isConnected = true;
    const { unmount } = renderHook(() => useGitStatusSubscription(featureId));
    unmount();
    expect(subscribeGitStatus).not.toHaveBeenCalled();
  });

  it("waits for connection and releases when disconnected", () => {
    const release = vi.fn();
    subscribeGitStatus.mockReturnValue(release);
    const { rerender, unmount } = renderHook(() => useGitStatusSubscription(7));
    expect(subscribeGitStatus).not.toHaveBeenCalled();
    storeState.isConnected = true;
    storeState.connectionEpoch = 1;
    rerender();
    expect(subscribeGitStatus).toHaveBeenCalledExactlyOnceWith(7);
    storeState.isConnected = false;
    rerender();
    expect(release).toHaveBeenCalledOnce();
    unmount();
    expect(release).toHaveBeenCalledOnce();
  });

  it("re-subscribes after a connection replacement even if React batches the disconnect", () => {
    storeState.isConnected = true;
    const releaseOld = vi.fn();
    const releaseNew = vi.fn();
    subscribeGitStatus.mockReturnValueOnce(releaseOld).mockReturnValueOnce(releaseNew);
    const { rerender, unmount } = renderHook(() => useGitStatusSubscription(7));
    storeState.connectionEpoch += 1;
    rerender();
    expect(releaseOld).toHaveBeenCalledOnce();
    expect(releaseNew).not.toHaveBeenCalled();
    expect(subscribeGitStatus).toHaveBeenCalledTimes(2);
    unmount();
    expect(releaseNew).toHaveBeenCalledOnce();
  });

  it("rebinds the watcher after a worktree transition, releasing the old subscription first", () => {
    storeState.isConnected = true;
    const calls: string[] = [];
    subscribeGitStatus.mockImplementation((id) => {
      calls.push(`subscribe:${id}`);
      return () => calls.push(`release:${id}`);
    });
    const { rerender, unmount } = renderHook(() => useGitStatusSubscription(7));
    gitStatusState.watcherEpoch = { 7: 1 };
    rerender();
    expect(calls).toEqual(["subscribe:7", "release:7", "subscribe:7"]);
    unmount();
  });

  it("releases the previous feature before subscribing to the next", () => {
    storeState.isConnected = true;
    const calls: string[] = [];
    subscribeGitStatus.mockImplementation((id) => {
      calls.push(`subscribe:${id}`);
      return () => calls.push(`release:${id}`);
    });
    const { rerender, unmount } = renderHook(({ id }) => useGitStatusSubscription(id), {
      initialProps: { id: 1 },
    });
    rerender({ id: 2 });
    expect(calls).toEqual(["subscribe:1", "release:1", "subscribe:2"]);
    unmount();
  });

  it("keeps the subscription across unrelated renders and another feature's watcher update", () => {
    storeState.isConnected = true;
    const { rerender, unmount } = renderHook(() => useGitStatusSubscription(7));
    gitStatusState.watcherEpoch = { 8: 1 };
    rerender();
    expect(subscribeGitStatus).toHaveBeenCalledExactlyOnceWith(7);
    unmount();
  });
});
