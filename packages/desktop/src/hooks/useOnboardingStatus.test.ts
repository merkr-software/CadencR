// @vitest-environment happy-dom
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useOnboardingStatus } from "./useOnboardingStatus";

const mockSetValue = vi.fn<(value: string) => Promise<boolean>>();
const mockUseQuery = vi.fn(() => ({ data: { value: "discover_cli" }, isLoading: false }));

vi.mock("@/api/generated", () => ({
  useGetWorkspaceSetting: () => mockUseQuery(),
}));

vi.mock("@/hooks/useSetting", () => ({
  useSettingWriter: () => ({ setValue: mockSetValue, isSaving: false }),
}));

describe("useOnboardingStatus", () => {
  beforeEach(() => {
    mockSetValue.mockReset().mockResolvedValue(true);
    mockUseQuery.mockReturnValue({ data: { value: "discover_cli" }, isLoading: false });
  });

  it("parses the persisted step from settings", () => {
    const { result } = renderHook(() => useOnboardingStatus());
    expect(result.current.step).toBe("discover_cli");
    expect(result.current.isCompleted).toBe(false);
  });

  it("falls back to welcome when no value is persisted", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockUseQuery.mockReturnValueOnce({ data: { value: null } as any, isLoading: false });
    const { result } = renderHook(() => useOnboardingStatus());
    expect(result.current.step).toBe("welcome");
  });

  it("flags isCompleted when the persisted step is 'completed'", () => {
    mockUseQuery.mockReturnValueOnce({ data: { value: "completed" }, isLoading: false });
    const { result } = renderHook(() => useOnboardingStatus());
    expect(result.current.isCompleted).toBe(true);
  });

  it("setStep resolves once the backend confirmed the step", async () => {
    const { result } = renderHook(() => useOnboardingStatus());
    await act(async () => {
      await result.current.setStep("pick_agent");
    });
    expect(mockSetValue).toHaveBeenCalledWith("pick_agent");
  });

  it("complete shortcuts to the 'completed' step", async () => {
    const { result } = renderHook(() => useOnboardingStatus());
    await act(async () => {
      await result.current.complete();
    });
    expect(mockSetValue).toHaveBeenCalledWith("completed");
  });

  it("rejects when the write fails, so the overlay can say so in place", async () => {
    mockSetValue.mockResolvedValueOnce(false);
    const { result } = renderHook(() => useOnboardingStatus());
    await act(async () => {
      await expect(result.current.setStep("pick_agent")).rejects.toThrow(
        "Could not save setup progress.",
      );
    });
  });
});
