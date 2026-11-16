// @vitest-environment happy-dom
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { toast } from "sonner";
import { resetPromptDraftMemoryForTest, usePromptDraft } from "./usePromptDraft";

const mockSetFeatureSettingMutate = vi.fn();
const mockFeatureSettingsData = vi.fn(
  (): Array<{ key: string; value: string }> | undefined => undefined,
);
const mockFeatureSettingsIsError = vi.fn((): boolean => false);
const mockFeatureSettingsError = vi.fn((): Error | null => null);
const mockSetQueryData = vi.fn();

interface SetFeatureSettingVariables {
  id: number;
  data: { key: string; value: string };
}

interface MutationCallbacks {
  onError?: (error: unknown) => void;
  onSuccess?: (data: unknown, variables: SetFeatureSettingVariables) => void;
}

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ setQueryData: mockSetQueryData }),
}));

vi.mock("../api/generated", () => ({
  getGetFeatureSettingsQueryKey: (id?: number) => [`/api/features/${id}/settings`],
  useSetFeatureSetting: vi.fn(() => ({ mutate: mockSetFeatureSettingMutate })),
  useGetFeatureSettings: vi.fn(() => ({
    data: mockFeatureSettingsData(),
    isError: mockFeatureSettingsIsError(),
    error: mockFeatureSettingsError(),
  })),
}));

function mutationCallbacksAt(index: number): MutationCallbacks | undefined {
  return mockSetFeatureSettingMutate.mock.calls[index]?.[1] as MutationCallbacks | undefined;
}

describe("usePromptDraft", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetPromptDraftMemoryForTest();
    mockSetFeatureSettingMutate.mockClear();
    mockFeatureSettingsData.mockReturnValue(undefined);
    mockFeatureSettingsIsError.mockReturnValue(false);
    mockFeatureSettingsError.mockReturnValue(null);
    mockSetQueryData.mockClear();
    vi.mocked(toast.error).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns no draft while feature settings are unavailable", () => {
    const { result } = renderHook(() => usePromptDraft({ featureId: 7 }));

    expect(result.current.initialDraft).toBeNull();
    expect(result.current.draftFeatureId).toBeNull();
  });

  it("returns null when no draft exists", () => {
    const { result } = renderHook(() => usePromptDraft({ featureId: 7 }));

    expect(result.current.initialDraft).toBeNull();
  });

  it("restores the draft from the owning feature settings", () => {
    mockFeatureSettingsData.mockReturnValue([{ key: "draft_prompt", value: "feature draft" }]);

    const { result } = renderHook(() => usePromptDraft({ featureId: 7 }));

    expect(result.current.initialDraft).toBe("feature draft");
    expect(result.current.draftFeatureId).toBe(7);
  });

  it("does not expose a previous feature draft while the next feature settings load", () => {
    mockFeatureSettingsData.mockReturnValueOnce([
      { key: "draft_prompt", value: "feature 7 draft" },
    ]);
    const { result, rerender } = renderHook(
      ({ featureId }: { featureId: number }) => usePromptDraft({ featureId }),
      { initialProps: { featureId: 7 } },
    );
    expect(result.current.initialDraft).toBe("feature 7 draft");

    mockFeatureSettingsData.mockReturnValueOnce(undefined);
    rerender({ featureId: 8 });

    expect(result.current.initialDraft).toBeNull();
  });

  it("treats an empty feature draft setting as no draft", () => {
    mockFeatureSettingsData.mockReturnValue([{ key: "draft_prompt", value: "" }]);

    const { result } = renderHook(() => usePromptDraft({ featureId: 7 }));

    expect(result.current.initialDraft).toBeNull();
  });

  it("saves the draft to the owning feature settings", () => {
    const { result } = renderHook(() => usePromptDraft({ featureId: 7 }));

    act(() => result.current.saveDraft("feature-local draft"));
    act(() => vi.advanceTimersByTime(500));

    expect(mockSetFeatureSettingMutate).toHaveBeenCalledWith(
      {
        id: 7,
        data: { key: "draft_prompt", value: "feature-local draft" },
      },
      expect.any(Object),
    );
  });

  it("patches the owning feature settings cache only after save succeeds", () => {
    const { result } = renderHook(() => usePromptDraft({ featureId: 7 }));

    expect(mockSetQueryData).not.toHaveBeenCalled();
    act(() => result.current.saveDraft("saved after confirmation"));
    act(() => vi.advanceTimersByTime(500));

    mutationCallbacksAt(0)?.onSuccess?.(undefined, {
      id: 7,
      data: { key: "draft_prompt", value: "saved after confirmation" },
    });

    expect(mockSetQueryData).toHaveBeenCalledWith(
      ["/api/features/7/settings"],
      expect.any(Function),
    );
    const updater = mockSetQueryData.mock.calls[0]?.[1] as
      | ((settings: Array<{ key: string; value: string }> | undefined) => Array<{
          key: string;
          value: string;
        }>)
      | undefined;
    expect(updater?.([{ key: "layout_state", value: "{}" }])).toEqual([
      { key: "layout_state", value: "{}" },
      { key: "draft_prompt", value: "saved after confirmation" },
    ]);
  });

  it("does not allocate a new settings cache value for unchanged drafts", () => {
    const { result } = renderHook(() => usePromptDraft({ featureId: 7 }));

    act(() => result.current.saveDraft("same draft"));
    act(() => vi.advanceTimersByTime(500));

    mutationCallbacksAt(0)?.onSuccess?.(undefined, {
      id: 7,
      data: { key: "draft_prompt", value: "same draft" },
    });

    const updater = mockSetQueryData.mock.calls[0]?.[1] as
      | ((settings: Array<{ key: string; value: string }> | undefined) => Array<{
          key: string;
          value: string;
        }>)
      | undefined;
    const settings = [{ key: "draft_prompt", value: "same draft" }];
    expect(updater?.(settings)).toBe(settings);
  });

  it("debounces multiple saves and persists only the last draft", () => {
    const { result } = renderHook(() => usePromptDraft({ featureId: 7 }));

    act(() => {
      result.current.saveDraft("a");
      result.current.saveDraft("ab");
      result.current.saveDraft("abc");
    });
    act(() => vi.advanceTimersByTime(500));

    expect(mockSetFeatureSettingMutate).toHaveBeenCalledTimes(1);
    expect(mockSetFeatureSettingMutate).toHaveBeenCalledWith(
      {
        id: 7,
        data: { key: "draft_prompt", value: "abc" },
      },
      expect.any(Object),
    );
  });

  it("flushes a pending draft on unmount", () => {
    const { result, unmount } = renderHook(() => usePromptDraft({ featureId: 7 }));

    act(() => result.current.saveDraft("pending on unmount"));
    unmount();

    expect(mockSetFeatureSettingMutate).toHaveBeenCalledWith(
      {
        id: 7,
        data: { key: "draft_prompt", value: "pending on unmount" },
      },
      expect.any(Object),
    );
  });

  it("does not save when no feature owns the prompt", () => {
    const { result } = renderHook(() => usePromptDraft({ featureId: undefined }));

    act(() => result.current.saveDraft("orphan draft"));
    act(() => vi.advanceTimersByTime(500));

    expect(mockSetFeatureSettingMutate).not.toHaveBeenCalled();
  });

  it("saves null as an empty feature draft setting", () => {
    const { result } = renderHook(() => usePromptDraft({ featureId: 7 }));

    act(() => result.current.saveDraft(null));
    act(() => vi.advanceTimersByTime(500));

    expect(mockSetFeatureSettingMutate).toHaveBeenCalledWith(
      {
        id: 7,
        data: { key: "draft_prompt", value: "" },
      },
      expect.any(Object),
    );
  });

  it("ignores an older save confirmation after a newer clear was requested", () => {
    const { result } = renderHook(() => usePromptDraft({ featureId: 7 }));

    act(() => result.current.saveDraft("already sent"));
    act(() => vi.advanceTimersByTime(500));
    act(() => result.current.saveDraft(null));

    mutationCallbacksAt(0)?.onSuccess?.(undefined, {
      id: 7,
      data: { key: "draft_prompt", value: "already sent" },
    });

    expect(mockSetQueryData).not.toHaveBeenCalled();
  });

  it("surfaces draft load and save failures to the user", () => {
    mockFeatureSettingsIsError.mockReturnValue(true);
    mockFeatureSettingsError.mockReturnValue(new Error("load failed"));

    const { result } = renderHook(() => usePromptDraft({ featureId: 7 }));
    act(() => result.current.saveDraft("will fail"));
    act(() => vi.advanceTimersByTime(500));
    mutationCallbacksAt(0)?.onError?.(new Error("save failed"));

    expect(toast.error).toHaveBeenCalledWith("Could not load draft: load failed");
    expect(toast.error).toHaveBeenCalledWith("Could not save draft: save failed");
  });
});
