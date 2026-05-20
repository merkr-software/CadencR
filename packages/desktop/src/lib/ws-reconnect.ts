/**
 * Per-key fixed-interval WebSocket reconnection manager.
 *
 * The service is local to the user's machine, so exponential backoff makes
 * recovery feel broken without protecting any remote dependency. Every
 * automatic retry waits exactly `RECONNECT_INTERVAL_MS`. After too many
 * consecutive failures, automatic retries pause and callers surface a
 * manual "Retry now" affordance.
 */

export const RECONNECT_INTERVAL_MS = 1000;
export const AUTO_RECONNECT_TIMEOUT_MS = 240_000;
export const AUTO_RECONNECT_TIMEOUT_SECONDS = AUTO_RECONNECT_TIMEOUT_MS / 1000;
export const MAX_AUTO_RECONNECT_FAILURES = Math.ceil(
  AUTO_RECONNECT_TIMEOUT_MS / RECONNECT_INTERVAL_MS,
);

interface ReconnectorOptions {
  onManualRequired?: (key: string) => void;
}

interface ForceReconnectOptions {
  bypassManualPause?: boolean;
}

interface ReconnectEntry {
  timer: ReturnType<typeof setTimeout> | null;
  firstFailureAt: number | null;
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

  if (entry.firstFailureAt == null) entry.firstFailureAt = Date.now();
  if (Date.now() - entry.firstFailureAt >= AUTO_RECONNECT_TIMEOUT_MS) {
    pauseForManualReconnect(key, entry);
    return;
  }

  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (entry.manualOnly) return;
    connect();
  }, RECONNECT_INTERVAL_MS);
}

export function resetReconnectState(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  entry.firstFailureAt = null;
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
 * Cancel the pending timer for `key` and invoke its connector now. Manual
 * calls also reset the failure cap; automatic watchdog calls respect a
 * paused/manual-only key.
 */
export function forceReconnect(key: string, options?: ForceReconnectOptions): void {
  const entry = entries.get(key);
  if (!entry?.connect) return;
  if (options?.bypassManualPause) {
    entry.firstFailureAt = null;
    entry.manualOnly = false;
  } else if (entry.manualOnly) {
    return;
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
