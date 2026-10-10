// @vitest-environment happy-dom
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useOnboardingStatus } from "./useOnboardingStatus";

const mockMutateAsync = vi.fn();
const mockUseQuery = vi.fn(() => ({ data: { value: "discover_cli" }, isLoading: false }));
const mockUseMutation = vi.fn(() => ({ mutateAsync: mockMutateAsync, isPending: false }));

vi.mock("@/api/generated", () => ({
  useGetWorkspaceSetting: () => mockUseQuery(),
  useSetWorkspaceSetting: () => mockUseMutation(),
  getGetWorkspaceSettingQueryKey: vi.fn((key: string) => ["workspace", "settings", key]),
}));

const mockSetQueryData = vi.fn();

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQueryClient: () => ({ setQueryData: mockSetQueryData }),
  };
});

const mockToastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => mockToastError(...args) } }));

describe("useOnboardingStatus", () => {
  beforeEach(() => {
    mockMutateAsync.mockReset();
    mockSetQueryData.mockReset();
    mockToastError.mockReset();
    mockUseQuery.mockReturnValue({ data: { value: "discover_cli" }, isLoading: false });
    mockUseMutation.mockReturnValue({ mutateAsync: mockMutateAsync, isPending: false });
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

  it("setStep awaits the mutation and writes the cache", async () => {
    mockMutateAsync.mockResolvedValueOnce({ value: "pick_agent" });
    const { result } = renderHook(() => useOnboardingStatus());
    await act(async () => {
      await result.current.setStep("pick_agent");
    });
    expect(mockMutateAsync).toHaveBeenCalledWith({
      key: "onboarding_step",
      data: { value: "pick_agent" },
    });
    expect(mockSetQueryData).toHaveBeenCalledWith(["workspace", "settings", "onboarding_step"], {
      value: "pick_agent",
    });
  });

  it("complete shortcuts to the 'completed' step", async () => {
    mockMutateAsync.mockResolvedValueOnce({ value: "completed" });
    const { result } = renderHook(() => useOnboardingStatus());
    await act(async () => {
      await result.current.complete();
    });
    expect(mockMutateAsync).toHaveBeenCalledWith({
      key: "onboarding_step",
      data: { value: "completed" },
    });
  });

  it("surfaces a toast and rethrows when the mutation fails", async () => {
    mockMutateAsync.mockRejectedValueOnce(new Error("boom"));
    const { result } = renderHook(() => useOnboardingStatus());
    await act(async () => {
      await expect(result.current.setStep("pick_agent")).rejects.toThrow("boom");
    });
    expect(mockToastError).toHaveBeenCalledWith(
      expect.stringContaining(`Could not save setting "onboarding_step"`),
    );
    expect(mockSetQueryData).not.toHaveBeenCalled();
  });
});
