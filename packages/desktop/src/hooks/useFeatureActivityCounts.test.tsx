import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearDesktopBridgeOverrideForTests,
  desktopBridge,
  setDesktopBridgeOverrideForTests,
} from "@/lib/desktop-bridge";

const showBrowserError = vi.hoisted(() => vi.fn());

vi.mock("@/api/generated", () => ({
  useListFeatureActivity: () => ({ data: [], error: null }),
}));
vi.mock("@/components/browser/browser-errors", () => ({ showBrowserError }));

const { useBrowserActivityBridge } = await import("./useFeatureActivityCounts");

afterEach(() => {
  clearDesktopBridgeOverrideForTests();
  showBrowserError.mockReset();
});

describe("useBrowserActivityBridge", () => {
  it("does not call or subscribe to the native browser outside Electron", async () => {
    const calls = {
      listBrowserTabCountsByScope: vi.fn(),
      listBrowserDownloadCountsByScope: vi.fn(),
      onBrowserTabCounts: vi.fn(),
      onBrowserDownloadCounts: vi.fn(),
    };
    setDesktopBridgeOverrideForTests({ isElectron: false, ...calls });
    const { unmount } = renderHook(() => useBrowserActivityBridge());
    await act(async () => undefined);
    unmount();
    for (const call of Object.values(calls)) expect(call).not.toHaveBeenCalled();
    expect(showBrowserError).not.toHaveBeenCalled();
  });

  it("still reports real desktop download failures", async () => {
    const error = new Error("download IPC failed");
    setDesktopBridgeOverrideForTests({
      isElectron: true,
      listBrowserTabCountsByScope: vi.fn(async () => ({})),
      listBrowserDownloadCountsByScope: vi.fn(async () => {
        throw error;
      }),
    });
    const { unmount } = renderHook(() => useBrowserActivityBridge());
    await waitFor(() =>
      expect(showBrowserError).toHaveBeenCalledWith(
        error,
        "Failed to load browser download counts",
      ),
    );
    unmount();
  });

  it("does not surface a stale hydration error after a live download count", async () => {
    const initial = deferred<Record<number, number>>();
    let listener: ((counts: Record<number, number>) => void) | null = null;
    setDesktopBridgeOverrideForTests({
      ...desktopBridge,
      isElectron: true,
      listBrowserTabCountsByScope: vi.fn(async () => ({})),
      onBrowserTabCounts: vi.fn(() => () => undefined),
      listBrowserDownloadCountsByScope: vi.fn(() => initial.promise),
      onBrowserDownloadCounts: vi.fn((callback) => {
        listener = callback;
        return () => undefined;
      }),
    });
    renderHook(() => useBrowserActivityBridge());
    await waitFor(() => expect(listener).not.toBeNull());

    act(() => listener?.({ 4: 1 }));
    await act(async () => initial.reject(new Error("stale download hydration failed")));

    expect(showBrowserError).not.toHaveBeenCalled();
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  reject: (error: unknown) => void;
} {
  let rejectPromise = (_error: unknown): void => undefined;
  const promise = new Promise<T>((_resolve, reject) => {
    rejectPromise = reject;
  });
  return { promise, reject: rejectPromise };
}
