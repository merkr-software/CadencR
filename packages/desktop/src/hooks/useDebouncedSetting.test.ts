import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useDebouncedSetting } from "./useDebouncedSetting";

const mockMutate = vi.fn();
const mockInvalidateQueries = vi.fn();
const mockUseQuery = vi.fn(() => ({ data: { value: "stored-value" }, isLoading: false }));

vi.mock("../api/generated", () => ({
  useGetWorkspaceSetting: () => mockUseQuery(),
  useSetWorkspaceSetting: vi.fn(() => ({ mutate: mockMutate })),
  getGetWorkspaceSettingQueryKey: vi.fn((key: string) => ["workspace", "settings", key]),
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
    mockMutate.mockReset();
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
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("calls mutate after debounce delay", () => {
    const { result } = renderHook(() => useDebouncedSetting("my-key", 300));
    act(() => {
      result.current.setValue("new-value");
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(mockMutate).toHaveBeenCalledWith(
      { key: "my-key", data: { value: "new-value" } },
      expect.any(Object),
    );
  });

  it("persists immediately when debounce is zero", () => {
    const { result } = renderHook(() => useDebouncedSetting("my-key", 0));
    act(() => {
      result.current.setValue("new-value");
    });
    expect(mockMutate).toHaveBeenCalledWith(
      { key: "my-key", data: { value: "new-value" } },
      expect.any(Object),
    );
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
    expect(mockMutate).toHaveBeenCalledTimes(1);
    expect(mockMutate).toHaveBeenCalledWith(
      { key: "my-key", data: { value: "val3" } },
      expect.any(Object),
    );
  });

  it("uses custom debounce interval", () => {
    const { result } = renderHook(() => useDebouncedSetting("my-key", 1000));
    act(() => {
      result.current.setValue("hello");
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(mockMutate).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(mockMutate).toHaveBeenCalledTimes(1);
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
    expect(mockMutate).toHaveBeenCalledWith(
      { key: "my-key", data: { value: "new-value" } },
      expect.any(Object),
    );
  });

  it("isLoading reflects query loading state", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockUseQuery.mockReturnValueOnce({ data: null as any, isLoading: true });
    const { result } = renderHook(() => useDebouncedSetting("loading-key"));
    expect(result.current.isLoading).toBe(true);
  });
});
