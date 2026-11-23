// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@/test-utils";
import { LIST_AFTER_MS, useSettledOffScreen } from "./useSettledOffScreen";

function renderOffScreen(initial: readonly string[]) {
  const view = renderHook(({ ids }) => useSettledOffScreen(ids), {
    initialProps: { ids: initial },
  });
  const wait = (ms: number): void =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  const listed = (): string[] => [...view.result.current].sort();
  return { ...view, wait, listed };
}

describe("useSettledOffScreen", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists an id once it has stayed off screen for the delay", () => {
    const { wait, listed } = renderOffScreen(["a"]);
    wait(LIST_AFTER_MS - 1);
    expect(listed()).toEqual([]);
    wait(1);
    expect(listed()).toEqual(["a"]);
  });

  it("drops an id back on screen in the same render", () => {
    const { wait, listed, rerender } = renderOffScreen(["a"]);
    wait(LIST_AFTER_MS);
    rerender({ ids: [] });
    expect(listed()).toEqual([]);
  });

  it("times each id from when it left, whatever the others do", () => {
    const { wait, listed, rerender } = renderOffScreen(["a"]);
    wait(200);
    rerender({ ids: ["a", "b"] });
    wait(50);
    expect(listed()).toEqual(["a"]);
    // t=250: a comes back, c leaves; b left at t=200.
    rerender({ ids: ["b"] });
    rerender({ ids: ["b", "c"] });
    wait(LIST_AFTER_MS - 50);
    expect(listed()).toEqual(["b"]);
    wait(50);
    expect(listed()).toEqual(["b", "c"]);
  });

  it("makes an id that came back wait anew", () => {
    const { wait, listed, rerender } = renderOffScreen(["a"]);
    wait(LIST_AFTER_MS);
    rerender({ ids: [] });
    rerender({ ids: ["a"] });
    wait(LIST_AFTER_MS - 1);
    expect(listed()).toEqual([]);
    wait(1);
    expect(listed()).toEqual(["a"]);
  });

  it("keeps its result's identity while nothing changes", () => {
    const { wait, result, rerender } = renderOffScreen(["a"]);
    wait(LIST_AFTER_MS);
    const first = result.current;
    rerender({ ids: ["a"] });
    wait(LIST_AFTER_MS);
    expect(result.current).toBe(first);
  });

  it("takes ids with spaces", () => {
    const { wait, listed } = renderOffScreen(["call 1", "call 2"]);
    wait(LIST_AFTER_MS);
    expect(listed()).toEqual(["call 1", "call 2"]);
  });
});
