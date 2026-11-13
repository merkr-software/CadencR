import { describe, it, expect, vi, afterEach } from "vitest";
import { scheduleDeltaFlush, setDeltaFlushScheduler } from "./ws-delta-scheduler";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("stream-delta flush scheduler", () => {
  it("flushes on a timer when the animation frame never runs", () => {
    vi.useFakeTimers();
    // An occluded, minimized or backgrounded window stops requestAnimationFrame
    // entirely, so a frame-only scheduler would hold the deltas indefinitely.
    vi.stubGlobal("requestAnimationFrame", vi.fn());
    setDeltaFlushScheduler(null);
    const flush = vi.fn();

    scheduleDeltaFlush(flush);
    expect(flush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("flushes once when the frame runs before the fallback timer", () => {
    vi.useFakeTimers();
    const frames: Array<(time: number) => void> = [];
    vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
      frames.push(callback);
      return 1;
    });
    setDeltaFlushScheduler(null);
    const flush = vi.fn();

    scheduleDeltaFlush(flush);
    frames[0](0);
    vi.advanceTimersByTime(1000);

    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("flushes on a microtask where no animation frame exists", async () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    setDeltaFlushScheduler(null);
    const flush = vi.fn();

    scheduleDeltaFlush(flush);
    expect(flush).not.toHaveBeenCalled();
    await Promise.resolve();

    expect(flush).toHaveBeenCalledTimes(1);
  });
});
