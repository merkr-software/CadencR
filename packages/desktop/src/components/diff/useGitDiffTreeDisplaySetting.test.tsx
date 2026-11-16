import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GIT_DIFF_TREE_DISPLAY_MODE_KEY,
  useGitDiffTreeDisplaySetting,
} from "./useGitDiffTreeDisplaySetting";

const mocks = vi.hoisted(() => ({
  value: undefined as string | undefined,
  isLoading: false,
  isSaving: false,
  error: null as Error | null,
  getSetting: vi.fn(),
  setValue: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/api/generated", () => ({
  useGetWorkspaceSetting: (key: string) => {
    mocks.getSetting(key);
    return {
      data: mocks.value === undefined ? undefined : { value: mocks.value },
      isLoading: mocks.isLoading,
      error: mocks.error,
    };
  },
}));

vi.mock("@/hooks/useSetting", () => ({
  useSettingWriter: () => ({
    setValue: mocks.setValue,
    isSaving: mocks.isSaving,
  }),
}));

vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));

describe("useGitDiffTreeDisplaySetting", () => {
  beforeEach(() => {
    mocks.value = undefined;
    mocks.isLoading = false;
    mocks.isSaving = false;
    mocks.error = null;
    mocks.getSetting.mockClear();
    mocks.setValue.mockReset().mockResolvedValue(true);
    mocks.toastError.mockClear();
  });

  it("loads and writes the exact global settings.json key without changing locally first", async () => {
    mocks.value = "tree";
    const { result, rerender } = renderHook(() => useGitDiffTreeDisplaySetting());

    expect(mocks.getSetting).toHaveBeenCalledWith(GIT_DIFF_TREE_DISPLAY_MODE_KEY);
    act(() => result.current.setDisplayMode("filenames"));
    expect(mocks.setValue).toHaveBeenCalledWith("filenames");
    expect(result.current.displayMode).toBe("tree");

    mocks.value = "filenames";
    rerender();
    expect(result.current.displayMode).toBe("filenames");
  });

  it("defaults unknown values to the directory tree and exposes load/save pending state", () => {
    mocks.value = "unsupported";
    mocks.isLoading = true;
    const { result, rerender } = renderHook(() => useGitDiffTreeDisplaySetting());

    expect(result.current.displayMode).toBe("tree");
    expect(result.current.isPending).toBe(true);

    mocks.isLoading = false;
    mocks.isSaving = true;
    rerender();
    expect(result.current.isPending).toBe(true);
  });

  it("surfaces a settings read failure to the user", async () => {
    mocks.error = new Error("settings unavailable");
    renderHook(() => useGitDiffTreeDisplaySetting());

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Could not load Git file-list setting: settings unavailable",
      ),
    );
  });
});
