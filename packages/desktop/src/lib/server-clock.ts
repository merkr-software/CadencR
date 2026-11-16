/**
 * This device's estimate of the server clock.
 *
 * Turn starts are stamped on the server. Converting them through this offset
 * makes elapsed timers agree across devices whose clocks disagree (a phone a
 * few seconds off the host), instead of each one measuring against its own
 * `Date.now()`.
 *
 * A `server_now_ms` stamp was taken before the message carrying it arrived, so
 * `server_now_ms - Date.now()` underestimates the offset by the transit time:
 * the largest sample since the connection opened is the most accurate one.
 */
let offsetMs: number | null = null;

// Smaller gains aren't worth re-anchoring every running timer (and re-rendering
// it) for: the display has one-second resolution.
const MIN_GAIN_MS = 25;

export function observeServerClock(serverNowMs: unknown): void {
  if (typeof serverNowMs !== "number" || !Number.isFinite(serverNowMs)) return;
  const sample = serverNowMs - Date.now();
  if (offsetMs == null || sample > offsetMs + MIN_GAIN_MS) offsetMs = sample;
}

/** Start over on a new connection: the device clock may have moved since. */
export function resetServerClock(): void {
  offsetMs = null;
}

/** A server-clock instant, expressed on this device's clock. */
export function serverToLocalMs(serverMs: number): number {
  return serverMs - (offsetMs ?? 0);
}
