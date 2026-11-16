import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELTA_FLUSH_FALLBACK_MS,
  scheduleDeltaFlush,
  setDeltaFlushScheduler,
} from "./ws-delta-scheduler";

describe("default stream-delta flush scheduler", () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextFrameId: number;

  function runNextFrame(): void {
    const next = frames.entries().next().value;
    expect(next).toBeDefined();
    if (!next) throw new Error("No animation frame scheduled");
    const [id, callback] = next;
    frames.delete(id);
    callback(0);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    frames = new Map();
    nextFrameId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = ++nextFrameId;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames.delete(id);
    });
    setDeltaFlushScheduler(null);
  });

  afterEach(() => {
    // Restore test-setup's synchronous scheduler for every other test.
    setDeltaFlushScheduler((flush) => flush());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("flushes on the next frame and cancels the fallback timer", () => {
    const flush = vi.fn();
    scheduleDeltaFlush(flush);
    expect(flush).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    runNextFrame();

    expect(flush).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(DELTA_FLUSH_FALLBACK_MS * 2);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("flushes without a frame and cancels the pending frame request", () => {
    const flush = vi.fn();
    scheduleDeltaFlush(flush);
    const lateFrame = frames.get(nextFrameId)!;

    vi.advanceTimersByTime(DELTA_FLUSH_FALLBACK_MS - 1);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(flush).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    // Even an already-dispatched losing callback cannot flush twice.
    lateFrame(0);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("does not accumulate frame callbacks across repeated timer-first flushes", () => {
    const flush = vi.fn();

    for (let i = 0; i < 100; i++) {
      scheduleDeltaFlush(flush);
      vi.advanceTimersByTime(DELTA_FLUSH_FALLBACK_MS);
      expect(flush).toHaveBeenCalledTimes(i + 1);
      expect(frames.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("does not accumulate fallback timers across repeated frame-first flushes", () => {
    const flush = vi.fn();

    for (let i = 0; i < 100; i++) {
      scheduleDeltaFlush(flush);
      runNextFrame();
      expect(flush).toHaveBeenCalledTimes(i + 1);
      expect(frames.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("flushes on a microtask when animation frames are unavailable", async () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    const flush = vi.fn();

    scheduleDeltaFlush(flush);
    expect(flush).not.toHaveBeenCalled();
    await Promise.resolve();

    expect(flush).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
