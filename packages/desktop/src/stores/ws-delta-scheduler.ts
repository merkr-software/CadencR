/**
 * Standalone flush scheduler for the stream-delta coalescer.
 *
 * Kept dependency-free (no store/handler imports) so tests can import
 * `setDeltaFlushScheduler` from here without dragging the whole session-handler
 * graph — importing that chain from a setup file loads `@/api/generated` before
 * a test's `vi.mock` can intercept it.
 */

/** Schedules a pending flush. Overridable so tests can flush synchronously. */
export type FlushScheduler = (flush: () => void) => void;

/**
 * Upper bound on how long a buffered delta may wait for a frame.
 *
 * `requestAnimationFrame` stops entirely while the window is occluded,
 * minimized or backgrounded, and the main window keeps Electron's default
 * `backgroundThrottling`. A frame-only scheduler then leaves a whole turn's
 * deltas buffered until the next non-delta envelope flushes them, which reads
 * as a frozen transcript that only catches up when the turn ends or the user
 * stops it. The timer keeps the one-commit-per-frame win on the normal path
 * and bounds the stall on the throttled one.
 */
const FALLBACK_FLUSH_MS = 250;

const defaultScheduler: FlushScheduler = (flush) => {
  if (typeof requestAnimationFrame !== "function") {
    queueMicrotask(flush);
    return;
  }
  let settled = false;
  const run = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    flush();
  };
  const timer = setTimeout(run, FALLBACK_FLUSH_MS);
  requestAnimationFrame(run);
};

let current: FlushScheduler = defaultScheduler;

/**
 * Override the flush scheduler. Tests install a synchronous scheduler (apply
 * immediately) or a manual one (capture the callback, fire it on demand to
 * assert one-commit-per-burst). Pass `null` to restore the rAF default.
 */
export function setDeltaFlushScheduler(scheduler: FlushScheduler | null): void {
  current = scheduler ?? defaultScheduler;
}

/** Run the current scheduler for a pending flush callback. */
export function scheduleDeltaFlush(flush: () => void): void {
  current(flush);
}
