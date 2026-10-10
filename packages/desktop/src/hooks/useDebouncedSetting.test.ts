import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useDebouncedSetting } from "./useDebouncedSetting";

const mockMutateAsync = vi.fn();
const mockToastError = vi.fn();
const mockInvalidateQueries = vi.fn();
const mockUseQuery = vi.fn(() => ({ data: { value: "stored-value" }, isLoading: false }));

vi.mock("../api/generated", () => ({
  useGetWorkspaceSetting: () => mockUseQuery(),
  useSetWorkspaceSetting: vi.fn(() => ({ mutateAsync: mockMutateAsync, isPending: false })),
  getGetWorkspaceSettingQueryKey: vi.fn((key: string) => ["workspace", "settings", key]),
}));

vi.mock("sonner", () => ({
  toast: { error: (message: string) => mockToastError(message) },
}));

const mockSetQueryData = vi.fn();
const mockGetQueryData = vi.fn();
const mockQueryClient = {
  invalidateQueries: mockInvalidateQueries,
  getQueryData: mockGetQueryData,
  setQueryData: mockSetQueryData,
};

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQueryClient: vi.fn(() => mockQueryClient),
  };
});

describe("useDebouncedSetting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockMutateAsync.mockReset();
    mockMutateAsync.mockResolvedValue({});
    mockToastError.mockClear();
    mockInvalidateQueries.mockClear();
    mockSetQueryData.mockClear();
    mockGetQueryData.mockClear();
    mockGetQueryData.mockReturnValue({ value: "stored-value" });
    mockUseQuery.mockReturnValue({ data: { value: "stored-value" }, isLoading: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the stored value from the query", () => {
    const { result } = renderHook(() => useDebouncedSetting("my-key"));
    expect(result.current.value).toBe("stored-value");
  });

  it("keeps the setter stable when the mutation result object is recreated", () => {
    const { result, rerender } = renderHook(() => useDebouncedSetting("my-key"));
    const initialSetter = result.current.setValue;

    rerender();

    expect(result.current.setValue).toBe(initialSetter);
  });

  it("does not call mutate immediately on setValue", () => {
    const { result } = renderHook(() => useDebouncedSetting("my-key"));
    act(() => {
      result.current.setValue("new-value");
    });
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it("calls mutate after debounce delay", () => {
    const { result } = renderHook(() => useDebouncedSetting("my-key", 300));
    act(() => {
      result.current.setValue("new-value");
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(mockMutateAsync).toHaveBeenCalledWith({ key: "my-key", data: { value: "new-value" } });
  });

  it("flushes the pending write on unmount instead of dropping it", () => {
    const { result, unmount } = renderHook(() => useDebouncedSetting("my-key", 500));
    act(() => {
      result.current.setValue("new-value");
    });
    expect(mockMutateAsync).not.toHaveBeenCalled();
    unmount();
    expect(mockMutateAsync).toHaveBeenCalledWith({ key: "my-key", data: { value: "new-value" } });
  });

  it("restores the cache and toasts when a write flushed on unmount is rejected", async () => {
    mockMutateAsync.mockImplementationOnce(() => Promise.reject(new Error("boom")));
    const { result, unmount } = renderHook(() => useDebouncedSetting("my-key", 500));
    act(() => {
      result.current.setValue("new-value");
    });
    unmount();
    // Let the rejection handlers run (they fire after unmount, so per-call
    // mutate callbacks would never see them).
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockSetQueryData).toHaveBeenLastCalledWith(["workspace", "settings", "my-key"], {
      value: "stored-value",
    });
    expect(mockToastError).toHaveBeenCalledWith('Could not save setting "my-key": boom');
  });

  it("persists immediately when debounce is zero", () => {
    const { result } = renderHook(() => useDebouncedSetting("my-key", 0));
    act(() => {
      result.current.setValue("new-value");
    });
    expect(mockMutateAsync).toHaveBeenCalledWith({ key: "my-key", data: { value: "new-value" } });
  });

  it("debounces multiple rapid calls — only calls mutate once", () => {
    const { result } = renderHook(() => useDebouncedSetting("my-key", 300));
    act(() => {
      result.current.setValue("val1");
      result.current.setValue("val2");
      result.current.setValue("val3");
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockMutateAsync).toHaveBeenCalledWith({ key: "my-key", data: { value: "val3" } });
  });

  it("uses custom debounce interval", () => {
    const { result } = renderHook(() => useDebouncedSetting("my-key", 1000));
    act(() => {
      result.current.setValue("hello");
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(mockMutateAsync).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(mockMutateAsync).toHaveBeenCalledTimes(1);
  });

  it("returns null when query returns no data", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockUseQuery.mockReturnValueOnce({ data: null as any, isLoading: false });
    const { result } = renderHook(() => useDebouncedSetting("missing-key"));
    expect(result.current.value).toBeNull();
  });

  it("updates query cache immediately by default", () => {
    const { result } = renderHook(() => useDebouncedSetting("my-key"));
    act(() => {
      result.current.setValue("new-value");
    });
    expect(mockSetQueryData).toHaveBeenCalledWith(["workspace", "settings", "my-key"], {
      value: "new-value",
    });
  });

  it("skips immediate cache update when immediateCache is false", () => {
    const { result } = renderHook(() =>
      useDebouncedSetting("my-key", 300, { immediateCache: false }),
    );
    act(() => {
      result.current.setValue("new-value");
    });
    expect(mockSetQueryData).not.toHaveBeenCalled();
    // But mutation still fires after debounce
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(mockMutateAsync).toHaveBeenCalledWith({ key: "my-key", data: { value: "new-value" } });
  });

  it("isLoading reflects query loading state", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockUseQuery.mockReturnValueOnce({ data: null as any, isLoading: true });
    const { result } = renderHook(() => useDebouncedSetting("loading-key"));
    expect(result.current.isLoading).toBe(true);
  });
});
