/**
 * Standalone flush scheduler for the stream-delta coalescer: the next
 * animation frame, or a timer when no frame comes (hidden window).
 *
 * Kept dependency-free (no store/handler imports) so tests can import
 * `setDeltaFlushScheduler` from here without dragging the whole session-handler
 * graph — importing that chain from a setup file loads `@/api/generated` before
 * a test's `vi.mock` can intercept it.
 */

/** Schedules a pending flush. Overridable so tests can flush synchronously. */
export type FlushScheduler = (flush: () => void) => void;

/**
 * How long a scheduled flush waits for an animation frame before it runs
 * anyway. A painting page flushes on the next frame (~16 ms) and the timer is
 * cancelled; a hidden or occluded window gets no frames at all, so without it
 * the deltas would pile up until the window shows again. Browsers throttle
 * hidden-page timers to about one per second, which is fine: nothing paints.
 */
export const DELTA_FLUSH_FALLBACK_MS = 100;

/** First of the next animation frame and the fallback timer; never both. */
const defaultScheduler: FlushScheduler = (flush) => {
  if (typeof requestAnimationFrame !== "function") {
    queueMicrotask(flush);
    return;
  }
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ran = false;
  const run = (): void => {
    if (ran) return;
    ran = true;
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    flush();
  };
  frame = requestAnimationFrame(run);
  timer = setTimeout(run, DELTA_FLUSH_FALLBACK_MS);
};

let current: FlushScheduler = defaultScheduler;

/**
 * Override the flush scheduler. Tests install a synchronous scheduler (apply
 * immediately) or a manual one (capture the callback, fire it on demand to
 * assert one-commit-per-burst). Pass `null` to restore the default.
 */
export function setDeltaFlushScheduler(scheduler: FlushScheduler | null): void {
  current = scheduler ?? defaultScheduler;
}

/** Run the current scheduler for a pending flush callback. */
export function scheduleDeltaFlush(flush: () => void): void {
  current(flush);
}
