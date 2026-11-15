// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELTA_FLUSH_FALLBACK_MS,
  scheduleDeltaFlush,
  setDeltaFlushScheduler,
} from "./ws-delta-scheduler";

describe("default stream-delta flush scheduler", () => {
  let frames: FrameRequestCallback[];

  beforeEach(() => {
    vi.useFakeTimers();
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames[id - 1] = () => {};
    });
    setDeltaFlushScheduler(null);
  });

  afterEach(() => {
    // test-setup's synchronous scheduler for every other test.
    setDeltaFlushScheduler((flush) => flush());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("flushes on the next frame while the page paints", () => {
    const flush = vi.fn();
    scheduleDeltaFlush(flush);
    expect(flush).not.toHaveBeenCalled();
    for (const frame of frames) frame(0);
    expect(flush).toHaveBeenCalledTimes(1);
    // The fallback timer is cancelled: no second flush.
    vi.advanceTimersByTime(DELTA_FLUSH_FALLBACK_MS * 2);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("still flushes when no animation frame comes (hidden or background window)", () => {
    const flush = vi.fn();
    scheduleDeltaFlush(flush);
    vi.advanceTimersByTime(DELTA_FLUSH_FALLBACK_MS);
    expect(flush).toHaveBeenCalledTimes(1);
    // A frame that arrives late must not apply the batch twice.
    for (const frame of frames) frame(0);
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
