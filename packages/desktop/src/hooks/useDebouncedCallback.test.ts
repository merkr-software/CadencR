// @vitest-environment happy-dom
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { useDebouncedCallback } from "./useDebouncedCallback";

describe("useDebouncedCallback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("invokes the callback once after the delay even when called many times", () => {
    const fn = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(fn, 150));

    act(() => {
      result.current();
      result.current();
      result.current();
    });

    expect(fn).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(150);
    });

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("passes the latest arguments to the callback", () => {
    const fn = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(fn, 100));

    act(() => {
      result.current(1);
      result.current(2);
      result.current(3);
    });

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(fn).toHaveBeenCalledWith(3);
  });

  it("captures the latest callback reference", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender } = renderHook(({ cb }) => useDebouncedCallback(cb, 50), {
      initialProps: { cb: first },
    });

    act(() => {
      result.current();
    });

    rerender({ cb: second });

    act(() => {
      vi.advanceTimersByTime(50);
    });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("cancels pending invocations on unmount", () => {
    const fn = vi.fn();
    const { result, unmount } = renderHook(() => useDebouncedCallback(fn, 100));

    act(() => {
      result.current();
    });

    unmount();

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(fn).not.toHaveBeenCalled();
  });
});
