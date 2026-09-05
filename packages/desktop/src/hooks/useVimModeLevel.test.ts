import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useDebouncedSetting", () => ({
  useDebouncedSetting: vi.fn(),
}));

const { useDebouncedSetting } = await import("@/hooks/useDebouncedSetting");
const { useVimModeLevel } = await import("./useVimModeLevel");

describe("useVimModeLevel", () => {
  it("parses the raw setting value", () => {
    vi.mocked(useDebouncedSetting).mockReturnValue({
      value: "2",
      setValue: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof useDebouncedSetting>);
    const { result } = renderHook(() => useVimModeLevel());
    expect(result.current).toBe("2");
  });

  it("falls back to the default for a stale or missing value", () => {
    vi.mocked(useDebouncedSetting).mockReturnValue({
      value: null,
      setValue: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof useDebouncedSetting>);
    const { result } = renderHook(() => useVimModeLevel());
    expect(result.current).toBe("0");
  });
});
