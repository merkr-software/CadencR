/**
 * Per-key WebSocket reconnection manager with exponential backoff + jitter.
 *
 * A fixed 1 s retry across every socket floods the backend's per-IP rate limit
 * on a remote/mobile link, and the resulting `429` fails the next handshake —
 * a self-feeding storm. Backoff (first retry fast, then doubling up to
 * `RECONNECT_MAX_MS`) plus `notifyRateLimited` (defer until a 429's
 * `Retry-After` elapses) break that loop. After `AUTO_RECONNECT_TIMEOUT_MS` of
 * continuous failure, automatic retries pause for a manual "Retry now".
 */

export const RECONNECT_INTERVAL_MS = 1000;
export const RECONNECT_MAX_MS = 30_000;
export const AUTO_RECONNECT_TIMEOUT_MS = 240_000;
export const AUTO_RECONNECT_TIMEOUT_SECONDS = AUTO_RECONNECT_TIMEOUT_MS / 1000;

/** Backoff for the Nth (1-based) consecutive failure, with half-range jitter. */
function backoffDelayMs(failures: number): number {
  const base = Math.min(RECONNECT_INTERVAL_MS * 2 ** Math.max(0, failures - 1), RECONNECT_MAX_MS);
  // Jitter into [base/2, base] to de-sync sockets that all dropped together.
  return Math.round(base - base * 0.5 * Math.random());
}

/**
 * Wall-clock millis until which the backend asked us to stop retrying (a 429
 * `Retry-After`). Shared across every key — one rate limit covers the whole IP.
 */
let rateLimitedUntil = 0;

/**
 * Record a backend rate-limit signal. Until `retryAfterMs` elapses, scheduled
 * reconnects wait at least that long so we stop feeding the 429 storm.
 */
export function notifyRateLimited(retryAfterMs: number): void {
  const until = Date.now() + Math.max(0, retryAfterMs);
  if (until > rateLimitedUntil) rateLimitedUntil = until;
}

/** Lift the rate-limit hold (the backend is reachable again). */
export function clearRateLimit(): void {
  rateLimitedUntil = 0;
}

interface ReconnectorOptions {
  onManualRequired?: (key: string) => void;
}

interface ForceReconnectOptions {
  bypassManualPause?: boolean;
}

interface ReconnectEntry {
  timer: ReturnType<typeof setTimeout> | null;
  firstFailureAt: number | null;
  /** Consecutive failures since the last successful connect; drives backoff. */
  failures: number;
  manualOnly: boolean;
  /** Latest connector seen for this key. Updated on every `scheduleReconnect`. */
  connect: (() => void) | null;
  onManualRequired: ((key: string) => void) | null;
}

const entries = new Map<string, ReconnectEntry>();

function getOrCreate(key: string): ReconnectEntry {
  let entry = entries.get(key);
  if (!entry) {
    entry = {
      timer: null,
      firstFailureAt: null,
      failures: 0,
      manualOnly: false,
      connect: null,
      onManualRequired: null,
    };
    entries.set(key, entry);
  }
  return entry;
}

function applyOptions(entry: ReconnectEntry, options?: ReconnectorOptions): void {
  if (options?.onManualRequired) entry.onManualRequired = options.onManualRequired;
}

function pauseForManualReconnect(key: string, entry: ReconnectEntry): void {
  if (entry.manualOnly) return;
  entry.manualOnly = true;
  entry.onManualRequired?.(key);
}

export function scheduleReconnect(
  key: string,
  connect: () => void,
  options?: ReconnectorOptions,
): void {
  const entry = getOrCreate(key);
  entry.connect = connect;
  applyOptions(entry, options);
  if (entry.timer) return;
  if (entry.manualOnly) return;

  const now = Date.now();
  if (entry.firstFailureAt == null) entry.firstFailureAt = now;
  if (now - entry.firstFailureAt >= AUTO_RECONNECT_TIMEOUT_MS) {
    pauseForManualReconnect(key, entry);
    return;
  }

  entry.failures += 1;
  // Wait at least the backoff, and never retry before a 429's Retry-After.
  const delay = Math.max(backoffDelayMs(entry.failures), rateLimitedUntil - now);

  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (entry.manualOnly) return;
    connect();
  }, delay);
}

export function resetReconnectState(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  entry.firstFailureAt = null;
  entry.failures = 0;
  entry.manualOnly = false;
}

export function clearReconnect(key: string): void {
  const entry = entries.get(key);
  if (entry?.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  entries.delete(key);
}

/**
 * Register a connector without scheduling a retry. Used by hooks/stores
 * that want to be reachable from `forceReconnectAll()` even before they've
 * suffered a close (e.g. terminals: connect once and stay connected, but
 * still reconnectable on wake).
 */
export function registerReconnector(
  key: string,
  connect: () => void,
  options?: ReconnectorOptions,
): void {
  const entry = getOrCreate(key);
  entry.connect = connect;
  applyOptions(entry, options);
}

export function unregisterReconnector(key: string): void {
  clearReconnect(key);
}

/**
 * Cancel the pending timer for `key` and invoke its connector now. An explicit
 * (manual) call resets the failure cap and lifts any rate-limit hold; automatic
 * watchdog calls respect a paused/manual-only key and the rate-limit hold, so a
 * wake/visibility storm can't hammer a backend that just returned 429.
 */
export function forceReconnect(key: string, options?: ForceReconnectOptions): void {
  const entry = entries.get(key);
  if (!entry?.connect) return;
  if (options?.bypassManualPause) {
    clearRateLimit();
    entry.firstFailureAt = null;
    entry.failures = 0;
    entry.manualOnly = false;
  } else {
    if (entry.manualOnly) return;
    if (Date.now() < rateLimitedUntil) return;
  }
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  entry.connect();
}

/** Force-reconnect every registered key. */
export function forceReconnectAll(options?: ForceReconnectOptions): void {
  for (const key of Array.from(entries.keys())) forceReconnect(key, options);
}
