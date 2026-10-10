// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useMonoFont } from "./mono-font-setting";
import { DEFAULT_MONO_STACK } from "./constants";

const setValue = vi.fn();
let mockValue: string | null = null;

vi.mock("@/hooks/useDebouncedSetting", () => ({
  useDebouncedSetting: () => ({ value: mockValue, setValue, isLoading: false }),
}));

describe("useMonoFont", () => {
  it("resolves to the default stack when unset", () => {
    mockValue = null;
    const { result } = renderHook(() => useMonoFont());
    expect(result.current.family).toBeNull();
    expect(result.current.resolved).toBe(DEFAULT_MONO_STACK);
  });

  it("normalizes a persisted empty string to the default state", () => {
    mockValue = "";
    const { result } = renderHook(() => useMonoFont());
    expect(result.current.family).toBeNull();
    expect(result.current.resolved).toBe(DEFAULT_MONO_STACK);
  });

  it("prepends the chosen family when set", () => {
    mockValue = "Fira Code";
    const { result } = renderHook(() => useMonoFont());
    expect(result.current.resolved).toBe(`"Fira Code", ${DEFAULT_MONO_STACK}`);
  });

  it("keeps its result stable when the setting values do not change", () => {
    mockValue = "Fira Code";
    const { result, rerender } = renderHook(() => useMonoFont());
    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
  });
});
