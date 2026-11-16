// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useStreamingMarkdownThrottle } from "./useStreamingMarkdownThrottle";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useStreamingMarkdownThrottle", () => {
  it("passes content through immediately when not streaming", () => {
    const { result, rerender } = renderHook(({ c, a }) => useStreamingMarkdownThrottle(c, a), {
      initialProps: { c: "a", a: false },
    });
    expect(result.current).toBe("a");
    rerender({ c: "abc", a: false });
    expect(result.current).toBe("abc");
  });

  it("throttles rapid updates while streaming, then catches up on the trailing edge", () => {
    const { result, rerender } = renderHook(({ c, a }) => useStreamingMarkdownThrottle(c, a), {
      initialProps: { c: "a", a: true },
    });
    // The initial content shows immediately.
    expect(result.current).toBe("a");

    // Bursts within the 100ms window do not advance the parsed content.
    rerender({ c: "ab", a: true });
    rerender({ c: "abc", a: true });
    rerender({ c: "abcd", a: true });
    expect(result.current).toBe("a");

    // The trailing timer flushes the latest content once the window elapses.
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe("abcd");
  });

  it("flushes to the latest content immediately when streaming stops", () => {
    const { result, rerender } = renderHook(({ c, a }) => useStreamingMarkdownThrottle(c, a), {
      initialProps: { c: "a", a: true },
    });
    rerender({ c: "ab", a: true }); // buffered, not yet shown
    expect(result.current).toBe("a");

    // Turn stops: the final content must appear without waiting for the timer.
    rerender({ c: "abcdef", a: false });
    expect(result.current).toBe("abcdef");
  });

  it("never publishes synchronously from the effect, even when the window is overdue", () => {
    const { result, rerender } = renderHook(({ c, a }) => useStreamingMarkdownThrottle(c, a), {
      initialProps: { c: "a", a: true },
    });
    // Drain the initial emit and let the 100ms window fully elapse.
    act(() => {
      vi.advanceTimersByTime(150);
    });

    // An overdue update is deferred to a 0ms timer task, not published from
    // the passive effect (a pending default-lane update at the tail of a sync
    // commit is what trips React's nested-update counter — error #185).
    rerender({ c: "ab", a: true });
    expect(result.current).toBe("a");
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(result.current).toBe("ab");
  });

  it("shows fresh content when a stream restarts after inactive changes", () => {
    const { result, rerender } = renderHook(({ c, a }) => useStreamingMarkdownThrottle(c, a), {
      initialProps: { c: "a", a: true },
    });
    rerender({ c: "ab", a: false }); // stream stops
    rerender({ c: "edited", a: false }); // content changes while inactive
    rerender({ c: "edited", a: true }); // stream restarts
    expect(result.current).toBe("edited"); // no stale "a" flash
  });

  it("leaves no pending publish once streaming stops", () => {
    const { result, rerender } = renderHook(({ c, a }) => useStreamingMarkdownThrottle(c, a), {
      initialProps: { c: "a", a: true },
    });
    rerender({ c: "ab", a: true }); // trailing timer armed
    rerender({ c: "abc", a: false });
    expect(result.current).toBe("abc");
    expect(vi.getTimerCount()).toBe(0);
  });
});
