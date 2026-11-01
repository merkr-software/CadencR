// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTelemetryActivity } from "./useTelemetryActivity";
import { activity as recordActivity } from "@/api/generated";

vi.mock("@/api/generated", () => ({ activity: vi.fn() }));
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(recordActivity).mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
});
describe("foreground monthly audience activity", () => {
  it("does not call protected activity until enabled and configured, and stops on opt-out", async () => {
    const { rerender, unmount } = renderHook(({ enabled }) => useTelemetryActivity(enabled), {
      initialProps: { enabled: false },
    });
    expect(recordActivity).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await act(async () => {});
    expect(recordActivity).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("pointerdown"));
    window.dispatchEvent(new Event("focus"));
    expect(recordActivity).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(60 * 60 * 1000);
    });
    expect(recordActivity).toHaveBeenCalledTimes(2);
    rerender({ enabled: false });
    await act(async () => {
      vi.advanceTimersByTime(60 * 60 * 1000);
    });
    expect(recordActivity).toHaveBeenCalledTimes(2);
    unmount();
  });
  it("waits while hidden, then records when visible", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const { unmount } = renderHook(() => useTelemetryActivity(true));
    expect(recordActivity).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(recordActivity).toHaveBeenCalledTimes(1);
    unmount();
    visibility.mockRestore();
  });
  it("surfaces activity errors and clears them after a successful retry", async () => {
    vi.mocked(recordActivity).mockRejectedValue(new Error("Service unavailable"));
    const { result, unmount } = renderHook(() => useTelemetryActivity(true));
    await act(async () => {});
    expect(result.current).toBe("Service unavailable");
    vi.mocked(recordActivity).mockResolvedValue(undefined);
    await act(async () => {
      vi.advanceTimersByTime(60 * 60 * 1000);
    });
    expect(result.current).toBeNull();
    unmount();
  });
});
