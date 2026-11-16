import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
} from "@/lib/desktop-bridge";
import {
  INITIAL_UPDATE_SNAPSHOT,
  reduceUpdateSnapshot,
  type UpdateEvent,
  type UpdateSnapshot,
} from "@/shared/update-state";
import { useUpdateStore } from "@/stores/update-store";
import { followUpdateCheck } from "./follow-update-check";

const toast = vi.hoisted(() => ({
  loading: vi.fn(() => "update-toast"),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));

/** The main process's state: every event is published to the renderer store. */
let main: UpdateSnapshot = INITIAL_UPDATE_SNAPSHOT;
function emit(event: UpdateEvent): UpdateSnapshot {
  main = reduceUpdateSnapshot(main, event);
  useUpdateStore.getState().receive(main);
  return main;
}

beforeEach(() => {
  vi.clearAllMocks();
  main = INITIAL_UPDATE_SNAPSHOT;
  useUpdateStore.setState({ ...INITIAL_UPDATE_SNAPSHOT });
  // A previous check's result must not settle this one.
  emit({ kind: "error", message: "old failure" });
});
afterEach(() => clearDesktopBridgeOverrideForTests());

describe("followUpdateCheck", () => {
  it("replaces the loading toast with the result main reports", async () => {
    setDesktopBridgeOverrideForTests({
      checkForUpdates: () => {
        const checking = emit({ kind: "checking" });
        // Main answers through a pushed state once the IPC call has returned.
        queueMicrotask(() =>
          emit({ kind: "error", message: "Updates are disabled in dev builds." }),
        );
        return Promise.resolve(checking);
      },
    });
    await followUpdateCheck();
    await Promise.resolve();
    expect(toast.loading).toHaveBeenCalledWith("Checking for updates…");
    expect(toast.error).toHaveBeenCalledWith(
      "Update check failed: Updates are disabled in dev builds.",
      { id: "update-toast" },
    );
  });

  it("reports an available update and stops following", async () => {
    setDesktopBridgeOverrideForTests({
      checkForUpdates: () => Promise.resolve(emit({ kind: "checking" })),
    });
    await followUpdateCheck();
    expect(toast.success).not.toHaveBeenCalled();
    emit({ kind: "available", version: "9.9.9" });
    emit({ kind: "downloaded", version: "9.9.9" });
    expect(toast.success).toHaveBeenCalledExactlyOnceWith("Update v9.9.9 available.", {
      id: "update-toast",
      description: expect.stringMatching(/Downloading it now/),
    });
  });

  it("stops following a check whose outcome never arrives", async () => {
    vi.useFakeTimers();
    try {
      setDesktopBridgeOverrideForTests({
        checkForUpdates: () => Promise.resolve(emit({ kind: "checking" })),
      });
      await followUpdateCheck();
      vi.advanceTimersByTime(30_000);
      expect(toast.info).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/Still checking/), {
        id: "update-toast",
      });
      emit({ kind: "not-available", version: "1.0.0" });
      expect(toast.success).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("followUpdateCheck when main cannot be asked", () => {
  it("turns the loading toast into the error", async () => {
    setDesktopBridgeOverrideForTests({
      checkForUpdates: () => Promise.reject(new Error("IPC unavailable")),
    });
    await followUpdateCheck();
    expect(toast.error).toHaveBeenCalledWith("IPC unavailable", { id: "update-toast" });
    expect(toast.info).not.toHaveBeenCalled();
  });
});
