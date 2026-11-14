import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCliFileOpenStore } from "@/stores/cli-file-open-store";
import { useCliPendingFileOpen } from "./useCliPendingFileOpen";

beforeEach(() => useCliFileOpenStore.setState({ pending: null }));

describe("useCliPendingFileOpen", () => {
  it("opens the pending file once in its own conversation only", () => {
    const open = vi.fn();
    const other = vi.fn();
    renderHook(() => useCliPendingFileOpen(9, true, open));
    renderHook(() => useCliPendingFileOpen(3, true, other));
    act(() =>
      useCliFileOpenStore.getState().request({ featureId: 9, relativePath: "a.ts", line: 2 }),
    );
    expect(open).toHaveBeenCalledExactlyOnceWith("a.ts", 2);
    expect(other).not.toHaveBeenCalled();
    expect(useCliFileOpenStore.getState().pending).toBeNull();
  });

  it("waits while the workspace is embedded", () => {
    const open = vi.fn();
    useCliFileOpenStore.getState().request({ featureId: 9, relativePath: "a.ts" });
    const { rerender } = renderHook(({ enabled }) => useCliPendingFileOpen(9, enabled, open), {
      initialProps: { enabled: false },
    });
    expect(open).not.toHaveBeenCalled();
    rerender({ enabled: true });
    expect(open).toHaveBeenCalledExactlyOnceWith("a.ts", undefined);
  });

  it("drops a request its workspace did not take in time", () => {
    const open = vi.fn();
    useCliFileOpenStore.getState().request({ featureId: 9, relativePath: "a.ts" });
    const requestedAt = useCliFileOpenStore.getState().pending?.at ?? 0;
    expect(useCliFileOpenStore.getState().take(9, requestedAt + 60_000)).toBeNull();
    expect(useCliFileOpenStore.getState().pending).toBeNull();
    renderHook(() => useCliPendingFileOpen(9, true, open));
    expect(open).not.toHaveBeenCalled();
  });
});
