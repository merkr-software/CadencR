import { uiI18n } from "@/lib/i18n/ui";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearDesktopBridgeOverrideForTests,
  desktopBridge,
  setDesktopBridgeOverrideForTests,
  type BrowserDownload,
  type BrowserDownloadSnapshot,
} from "@/lib/desktop-bridge";
import { useBrowserDownloads } from "./useBrowserDownloads";

afterEach(async () => {
  clearDesktopBridgeOverrideForTests();
  await act(async () => {
    await uiI18n.changeLanguage("en");
  });
});

describe("useBrowserDownloads", () => {
  it("relocalizes a fallback in place without resubscribing, reloading, or replaying actions", async () => {
    const listBrowserDownloads = vi.fn().mockResolvedValue(snapshot(4, 5));
    const onBrowserDownloadsChanged = vi.fn(() => () => undefined);
    const pauseBrowserDownload = vi.fn().mockRejectedValueOnce(null);
    setDesktopBridgeOverrideForTests({
      ...desktopBridge,
      listBrowserDownloads,
      onBrowserDownloadsChanged,
      pauseBrowserDownload,
    });
    const { result } = renderHook(() => useBrowserDownloads(4));
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    await act(() => result.current.pause("download-id"));
    expect(result.current.error).toBe("The download action failed.");

    await act(async () => {
      await uiI18n.changeLanguage("cimode");
    });
    expect(result.current.error).toBe(
      "workspace.tools.useBrowserDownloads.theDownloadActionFailed",
    );
    expect(listBrowserDownloads).toHaveBeenCalledTimes(1);
    expect(onBrowserDownloadsChanged).toHaveBeenCalledTimes(1);
    expect(pauseBrowserDownload).toHaveBeenCalledTimes(1);
  });

  it("keeps a newer event snapshot when the initial list resolves late", async () => {
    const initial = deferred<BrowserDownloadSnapshot>();
    let listener: ((snapshot: BrowserDownloadSnapshot) => void) | null = null;
    setDesktopBridgeOverrideForTests({
      ...desktopBridge,
      listBrowserDownloads: vi.fn(() => initial.promise),
      onBrowserDownloadsChanged: vi.fn((callback) => {
        listener = callback;
        return () => undefined;
      }),
    });
    const { result } = renderHook(() => useBrowserDownloads(4));
    await waitFor(() => expect(listener).not.toBeNull());

    act(() => listener?.(snapshot(4, 20)));
    await act(async () => initial.resolve(snapshot(4, 10)));

    expect(result.current.snapshot?.downloads[0].receivedBytes).toBe(20);
  });

  it("ignores old-scope lists after switching workspaces", async () => {
    const first = deferred<BrowserDownloadSnapshot>();
    const second = deferred<BrowserDownloadSnapshot>();
    setDesktopBridgeOverrideForTests({
      ...desktopBridge,
      listBrowserDownloads: vi.fn((scopeId) => (scopeId === 1 ? first.promise : second.promise)),
      onBrowserDownloadsChanged: vi.fn(() => () => undefined),
    });
    const { result, rerender } = renderHook(
      ({ scopeId }: { scopeId: number }) => useBrowserDownloads(scopeId),
      { initialProps: { scopeId: 1 } },
    );
    rerender({ scopeId: 2 });
    await act(async () => first.resolve(snapshot(1, 10)));
    await act(async () => second.resolve(snapshot(2, 30)));

    expect(result.current.snapshot?.scopeId).toBe(2);
    expect(result.current.snapshot?.downloads[0].receivedBytes).toBe(30);
  });

  it("serializes actions and ignores replies older than an event", async () => {
    const pause = deferred<BrowserDownloadSnapshot>();
    let listener: ((snapshot: BrowserDownloadSnapshot) => void) | null = null;
    const resumeBrowserDownload = vi.fn(() => Promise.resolve(snapshot(4, 15)));
    setDesktopBridgeOverrideForTests({
      ...desktopBridge,
      listBrowserDownloads: vi.fn(() => Promise.resolve(snapshot(4, 5))),
      pauseBrowserDownload: vi.fn(() => pause.promise),
      resumeBrowserDownload,
      onBrowserDownloadsChanged: vi.fn((callback) => {
        listener = callback;
        return () => undefined;
      }),
    });
    const { result } = renderHook(() => useBrowserDownloads(4));
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());

    let pausing = Promise.resolve();
    act(() => {
      pausing = result.current.pause("download-id");
      void result.current.resume("download-id");
    });
    expect(resumeBrowserDownload).not.toHaveBeenCalled();
    act(() => listener?.(snapshot(4, 20)));
    await act(async () => pause.resolve(snapshot(4, 10)));
    await pausing;

    expect(result.current.snapshot?.downloads[0].receivedBytes).toBe(20);
    expect(result.current.pending).toBeNull();
  });

  it("hides the previous scope immediately while its action is pending", async () => {
    const pausing = deferred<BrowserDownloadSnapshot>();
    const second = deferred<BrowserDownloadSnapshot>();
    setDesktopBridgeOverrideForTests({
      ...desktopBridge,
      listBrowserDownloads: vi.fn((scopeId) =>
        scopeId === 1 ? Promise.resolve(snapshot(1, 5)) : second.promise,
      ),
      pauseBrowserDownload: vi.fn(() => pausing.promise),
      onBrowserDownloadsChanged: vi.fn(() => () => undefined),
    });
    const { result, rerender } = renderHook(
      ({ scopeId }: { scopeId: number }) => useBrowserDownloads(scopeId),
      { initialProps: { scopeId: 1 } },
    );
    await waitFor(() => expect(result.current.snapshot?.scopeId).toBe(1));
    act(() => {
      void result.current.pause("download-id");
    });

    rerender({ scopeId: 2 });
    expect(result.current.snapshot).toBeNull();
    await act(async () => pausing.resolve(snapshot(1, 10)));
    expect(result.current.snapshot).toBeNull();
    await act(async () => second.resolve(snapshot(2, 30)));
    expect(result.current.snapshot?.scopeId).toBe(2);
  });
});

function snapshot(scopeId: number, receivedBytes: number): BrowserDownloadSnapshot {
  return {
    scopeId,
    downloads: [download(scopeId, receivedBytes)],
    activeCount: 1,
    aggregatePercent: receivedBytes,
  };
}

function download(scopeId: number, receivedBytes: number): BrowserDownload {
  return {
    id: "download-id",
    tabId: "tab-id",
    scopeId,
    filename: "report.txt",
    destination: "/Users/test/Downloads/report.txt",
    state: "progressing",
    receivedBytes,
    totalBytes: 100,
    bytesPerSecond: 10,
    percent: receivedBytes,
    canPause: true,
    canResume: false,
    canCancel: true,
    private: false,
    startedAt: "2026-09-08T10:00:00.000Z",
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
