// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useControllableBoolean } from "./useControllableBoolean";

describe("useControllableBoolean", () => {
  it("defaults to `defaultValue` when uncontrolled", () => {
    const { result } = renderHook(() =>
      useControllableBoolean({ value: undefined, defaultValue: true }),
    );
    expect(result.current.value).toBe(true);
  });

  it("toggles internal state when uncontrolled and fires onChange", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useControllableBoolean({ value: undefined, defaultValue: false, onChange }),
    );
    act(() => result.current.toggle());
    expect(result.current.value).toBe(true);
    expect(onChange).toHaveBeenCalledWith(true);
    act(() => result.current.toggle());
    expect(result.current.value).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it("never mutates internal state when controlled — only fires onChange", () => {
    const onChange = vi.fn();
    const { result, rerender } = renderHook(
      ({ value }) => useControllableBoolean({ value, onChange }),
      { initialProps: { value: true } },
    );
    act(() => result.current.toggle());
    // Parent owns the value — the hook should not have flipped it locally.
    expect(result.current.value).toBe(true);
    expect(onChange).toHaveBeenCalledWith(false);
    // Parent commits the change on the next render.
    rerender({ value: false });
    expect(result.current.value).toBe(false);
  });

  it("returns a referentially stable toggle across renders", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useControllableBoolean({ value, defaultValue: false }),
      { initialProps: { value: undefined as boolean | undefined } },
    );
    const initialToggle = result.current.toggle;
    act(() => result.current.toggle());
    rerender({ value: undefined });
    expect(result.current.toggle).toBe(initialToggle);
  });
});
