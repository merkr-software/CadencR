/**
 * How long a viewport reading keeps being refreshed after an event. A fold or
 * a rotation reports its new size and safe areas over several events, some
 * with in-between values, and the last change does not always fire one of
 * its own: on an iPhone Duo unfolding, `resize` arrived with the folded
 * height and nothing followed when it grew, leaving the app at 70% of the
 * screen.
 */
const SETTLE_MS = 600;

export interface WatchViewportOptions {
  /**
   * Also follow the visual viewport's `resize` (default true): the on-screen
   * keyboard and pinch-zoom. Off for a reading of the layout viewport alone.
   */
  visualViewport?: boolean;
}

/**
 * Calls `read` now and on every viewport change (window resize, orientation
 * change, visual viewport resize unless opted out), then once a frame until
 * the viewport has been quiet for `SETTLE_MS`. `read` should be cheap and
 * skip writes that change nothing. Returns the cleanup.
 */
export function watchViewport(
  read: () => void,
  { visualViewport = true }: WatchViewportOptions = {},
): () => void {
  let settleUntil = 0;
  let frame = 0;
  const settle = (): void => {
    read();
    frame = performance.now() < settleUntil ? requestAnimationFrame(settle) : 0;
  };
  const onChange = (): void => {
    read();
    settleUntil = performance.now() + SETTLE_MS;
    if (frame === 0) frame = requestAnimationFrame(settle);
  };

  read();
  const viewport = visualViewport ? window.visualViewport : null;
  const orientation = window.screen.orientation as ScreenOrientation | undefined;
  window.addEventListener("resize", onChange);
  viewport?.addEventListener("resize", onChange);
  orientation?.addEventListener("change", onChange);
  return () => {
    window.removeEventListener("resize", onChange);
    viewport?.removeEventListener("resize", onChange);
    orientation?.removeEventListener("change", onChange);
    if (frame !== 0) cancelAnimationFrame(frame);
  };
}
