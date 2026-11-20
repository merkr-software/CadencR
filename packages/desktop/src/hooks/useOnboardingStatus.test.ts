// @vitest-environment happy-dom
import { renderHook, act } from "@testing-library/react";
import { AxiosError, AxiosHeaders } from "axios";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useOnboardingStatus } from "./useOnboardingStatus";

const mockSetValue = vi.fn<(value: string) => Promise<boolean>>();
const mockUseQuery = vi.fn(() => ({ data: { value: "discover_cli" }, isLoading: false }));

const mockQueryOptions = vi.fn();

vi.mock("@/api/generated", () => ({
  useGetWorkspaceSetting: (_key: string, options: unknown) => {
    mockQueryOptions(options);
    return mockUseQuery();
  },
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

  // An unreadable settings file stays unreadable: retrying it only delays the
  // explanation behind a setup screen.
  it("reports an unreadable settings file without retrying it", () => {
    renderHook(() => useOnboardingStatus());
    const options: unknown = mockQueryOptions.mock.calls[0]?.[0];
    const retry = (options as { query?: { retry?: unknown } } | undefined)?.query?.retry;
    if (typeof retry !== "function") throw new Error("expected a retry policy");

    expect(retry(0, errorWithCode("SETTINGS_READ_FAILED"))).toBe(false);
    expect(retry(0, errorWithCode("DATABASE_BUSY"))).toBe(true);
    expect(retry(1, errorWithCode("DATABASE_BUSY"))).toBe(false);
  });
});

function errorWithCode(code: string): AxiosError {
  const headers = new AxiosHeaders();
  return new AxiosError("failed", "ERR_BAD_REQUEST", undefined, null, {
    status: 422,
    statusText: "",
    headers,
    config: { headers },
    data: { code, error: "failed" },
  });
}
