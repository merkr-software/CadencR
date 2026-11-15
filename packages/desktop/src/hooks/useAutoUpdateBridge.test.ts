// @vitest-environment happy-dom
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
} from "@/lib/desktop-bridge";
import { INITIAL_UPDATE_SNAPSHOT, type UpdateSnapshot } from "@/shared/update-state";
import { useUpdateStore } from "@/stores/update-store";
import { useAutoUpdateBridge } from "./useAutoUpdateBridge";

const downloaded: UpdateSnapshot = {
  ...INITIAL_UPDATE_SNAPSHOT,
  revision: 4,
  status: "downloaded",
  version: "0.2.0",
  progress: 100,
};

function resetRendererStore(): void {
  useUpdateStore.setState({ ...INITIAL_UPDATE_SNAPSHOT, installWhenAgentsFinish: false });
}

describe("useAutoUpdateBridge", () => {
  let emit: ((snapshot: UpdateSnapshot) => void) | null = null;

  beforeEach(() => {
    resetRendererStore();
    setDesktopBridgeOverrideForTests({
      getUpdateState: vi.fn(() => Promise.resolve(downloaded)),
      onUpdateState: vi.fn((cb: (snapshot: UpdateSnapshot) => void) => {
        emit = cb;
        return () => {
          emit = null;
        };
      }),
    });
  });

  afterEach(() => {
    clearDesktopBridgeOverrideForTests();
    emit = null;
  });

  it("restores the main process's update state after a renderer reload", async () => {
    const first = renderHook(() => useAutoUpdateBridge());
    await waitFor(() => expect(useUpdateStore.getState().status).toBe("downloaded"));
    first.unmount();

    // A reload starts from an empty renderer store.
    resetRendererStore();
    renderHook(() => useAutoUpdateBridge());
    await waitFor(() =>
      expect(useUpdateStore.getState()).toMatchObject({ status: "downloaded", version: "0.2.0" }),
    );
  });

  it("keeps a newer pushed state over an older mount-time read", async () => {
    let resolveRead: (snapshot: UpdateSnapshot) => void = () => {};
    setDesktopBridgeOverrideForTests({
      getUpdateState: vi.fn(
        () =>
          new Promise<UpdateSnapshot>((resolve) => {
            resolveRead = resolve;
          }),
      ),
      onUpdateState: vi.fn((cb: (snapshot: UpdateSnapshot) => void) => {
        emit = cb;
        return () => undefined;
      }),
    });
    renderHook(() => useAutoUpdateBridge());
    emit?.({ ...downloaded, revision: 5, status: "error", error: "disk full" });
    resolveRead(downloaded);

    await waitFor(() => expect(useUpdateStore.getState().status).toBe("error"));
    await Promise.resolve();
    expect(useUpdateStore.getState()).toMatchObject({ status: "error", revision: 5 });
  });
});
