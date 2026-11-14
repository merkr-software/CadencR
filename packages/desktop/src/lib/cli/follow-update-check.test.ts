import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
} from "@/lib/desktop-bridge";
import { useUpdateStore } from "@/stores/update-store";
import { followUpdateCheck } from "./follow-update-check";

const toast = vi.hoisted(() => ({
  loading: vi.fn(() => "update-toast"),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));

beforeEach(() => {
  vi.clearAllMocks();
  // A previous check's result must not settle this one.
  useUpdateStore.setState({ status: "error", error: "old failure", version: null });
});
afterEach(() => clearDesktopBridgeOverrideForTests());

describe("followUpdateCheck", () => {
  it("replaces the loading toast with the result main reports", async () => {
    setDesktopBridgeOverrideForTests({
      checkForUpdates: () => {
        // Main answers through an event once the IPC call has returned.
        queueMicrotask(() =>
          useUpdateStore
            .getState()
            .applyEvent({ kind: "error", message: "Updates are disabled in dev builds." }),
        );
        return Promise.resolve();
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
    setDesktopBridgeOverrideForTests({ checkForUpdates: () => Promise.resolve() });
    await followUpdateCheck();
    expect(toast.success).not.toHaveBeenCalled();
    useUpdateStore.getState().applyEvent({ kind: "available", version: "9.9.9" });
    useUpdateStore.getState().applyEvent({ kind: "downloaded", version: "9.9.9" });
    expect(toast.success).toHaveBeenCalledExactlyOnceWith("Update v9.9.9 available.", {
      id: "update-toast",
      description: expect.stringMatching(/Downloading it now/),
    });
  });

  it("stops following a check whose outcome never arrives", async () => {
    vi.useFakeTimers();
    try {
      setDesktopBridgeOverrideForTests({ checkForUpdates: () => Promise.resolve() });
      await followUpdateCheck();
      vi.advanceTimersByTime(30_000);
      expect(toast.info).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/Still checking/), {
        id: "update-toast",
      });
      useUpdateStore.getState().applyEvent({ kind: "not-available", version: "1.0.0" });
      expect(toast.success).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
