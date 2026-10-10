// @vitest-environment happy-dom
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useSetWorkspaceSettingWithCache } from "./useSetWorkspaceSettingWithCache";

const mockMutateAsync = vi.fn();
const mockUseMutation = vi.fn(() => ({ mutateAsync: mockMutateAsync, isPending: false }));

vi.mock("@/api/generated", () => ({
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

describe("useSetWorkspaceSettingWithCache", () => {
  beforeEach(() => {
    mockMutateAsync.mockReset();
    mockSetQueryData.mockReset();
    mockToastError.mockReset();
    mockUseMutation.mockReturnValue({ mutateAsync: mockMutateAsync, isPending: false });
  });

  it("awaits the mutation and patches the cache on success", async () => {
    mockMutateAsync.mockResolvedValueOnce({ value: "blue" });
    const { result } = renderHook(() => useSetWorkspaceSettingWithCache("color"));
    await act(async () => {
      await result.current.setValue("blue");
    });
    expect(mockMutateAsync).toHaveBeenCalledWith({ key: "color", data: { value: "blue" } });
    expect(mockSetQueryData).toHaveBeenCalledWith(["workspace", "settings", "color"], {
      value: "blue",
    });
  });

  it("does not patch the cache when the mutation rejects, and surfaces a toast", async () => {
    mockMutateAsync.mockRejectedValueOnce(new Error("kaboom"));
    const { result } = renderHook(() => useSetWorkspaceSettingWithCache("color"));
    await act(async () => {
      await expect(result.current.setValue("blue")).rejects.toThrow("kaboom");
    });
    expect(mockSetQueryData).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith(
      expect.stringContaining(`Could not save setting "color"`),
    );
  });

  it("reflects the mutation's pending state", () => {
    mockUseMutation.mockReturnValueOnce({ mutateAsync: mockMutateAsync, isPending: true });
    const { result } = renderHook(() => useSetWorkspaceSettingWithCache("color"));
    expect(result.current.isPending).toBe(true);
  });
});
