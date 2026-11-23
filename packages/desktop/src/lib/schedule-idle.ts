export interface ScheduleIdleOptions {
  /**
   * Run anyway once this long has passed without an idle period. Without it,
   * the callback waits for one however long that takes.
   */
  timeout?: number;
}

/** Whether this browser reports idle periods (Safari and the test DOMs do not). */
export function idleCallbacksAvailable(): boolean {
  return typeof requestIdleCallback === "function";
}

/**
 * Run `callback` when the main thread is idle. Where the browser has no idle
 * callbacks it runs after `options.timeout` (at once without one). Returns its
 * cancel function.
 */
export function scheduleIdle(callback: () => void, options?: ScheduleIdleOptions): () => void {
  const timeout = options?.timeout;
  if (idleCallbacksAvailable()) {
    const handle = requestIdleCallback(
      () => callback(),
      timeout === undefined ? undefined : { timeout },
    );
    return () => cancelIdleCallback(handle);
  }
  const timer = window.setTimeout(callback, timeout ?? 0);
  return () => window.clearTimeout(timer);
}

/**
 * Wait `delayMs`, then run `callback` at the next idle period (`scheduleIdle`).
 * Returns one cancel function for both steps.
 */
export function scheduleIdleAfter(
  delayMs: number,
  callback: () => void,
  options?: ScheduleIdleOptions,
): () => void {
  let cancelIdle: (() => void) | null = null;
  const timer = window.setTimeout(() => {
    cancelIdle = scheduleIdle(callback, options);
  }, delayMs);
  return () => {
    window.clearTimeout(timer);
    cancelIdle?.();
  };
}
