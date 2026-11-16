// @vitest-environment happy-dom
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useSetting", () => ({
  useSetting: vi.fn(),
}));

const { useSetting } = await import("@/hooks/useSetting");
const { useVimModeLevel } = await import("./useVimModeLevel");

describe("useVimModeLevel", () => {
  it("parses the raw setting value", () => {
    vi.mocked(useSetting).mockReturnValue({
      value: "2",
      setValue: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof useSetting>);
    const { result } = renderHook(() => useVimModeLevel());
    expect(result.current).toBe("2");
  });

  it("falls back to the default for a stale or missing value", () => {
    vi.mocked(useSetting).mockReturnValue({
      value: null,
      setValue: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof useSetting>);
    const { result } = renderHook(() => useVimModeLevel());
    expect(result.current).toBe("0");
  });
});
