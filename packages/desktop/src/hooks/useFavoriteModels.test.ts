// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFavoriteModels } from "./useFavoriteModels";

const setValue = vi.fn();
const toastError = vi.fn();
let storedValue: string | null = null;

vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toastError(...args) },
}));

vi.mock("@/api/settings", () => ({
  useGetWorkspaceSettings: () => ({ data: [], isLoading: false }),
  settingsArrayToMap: () => ({}),
}));

vi.mock("./useDebouncedSetting", () => ({
  useDebouncedSettingFromMap: () => ({ value: storedValue, setValue, isLoading: false }),
}));

describe("useFavoriteModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storedValue = null;
  });

  it("treats an unset setting as no favorites", () => {
    const { result } = renderHook(() => useFavoriteModels());
    expect(result.current.favorites.size).toBe(0);
  });

  it("adds a key that is not starred yet", () => {
    storedValue = JSON.stringify(["codex:gpt-5"]);
    const { result } = renderHook(() => useFavoriteModels());

    act(() => result.current.toggleFavorite("claude_code:opus"));

    expect(setValue).toHaveBeenCalledWith(JSON.stringify(["codex:gpt-5", "claude_code:opus"]));
  });

  it("removes a key that is already starred", () => {
    storedValue = JSON.stringify(["codex:gpt-5", "claude_code:opus"]);
    const { result } = renderHook(() => useFavoriteModels());

    act(() => result.current.toggleFavorite("codex:gpt-5"));

    expect(setValue).toHaveBeenCalledWith(JSON.stringify(["claude_code:opus"]));
  });

  it("surfaces a malformed setting instead of silently dropping the list", () => {
    storedValue = "not json";
    const { result } = renderHook(() => useFavoriteModels());

    expect(result.current.favorites.size).toBe(0);
    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining("Could not read your starred models"),
      // Shared id so N mounted pickers collapse into one toast.
      { id: "favorite_models" },
    );
  });
});
