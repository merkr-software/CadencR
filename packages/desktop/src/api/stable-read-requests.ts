import { CanceledError, type AxiosRequestConfig, type GenericAbortSignal } from "axios";

const STRICT_MODE_STABLE_GET_PATHS = ["/api/git/", "/api/feature-layouts"];
export const STRICT_MODE_STABLE_RESULT_TTL_MS = 250;
export const STRICT_MODE_ABORT_GRACE_MS = 75;

type SettledOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

interface InFlightStableRead {
  controller: AbortController;
  outcome: Promise<SettledOutcome<unknown>>;
  activeSubscribers: number;
  abortTimer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

export interface StableReadOptions {
  /** Grace window before aborting after the last subscriber detaches (DEV StrictMode). */
  graceMs: number;
  /** Short-lived result cache duration after completion (DEV StrictMode). */
  resultTtlMs: number;
}

interface CachedStableReadResult {
  expiresAt: number;
  value: unknown;
  evictTimer: ReturnType<typeof setTimeout>;
}

const stableReadRequests = new Map<string, InFlightStableRead>();
const stableReadResults = new Map<string, CachedStableReadResult>();

/** Reset in-flight and cached stable read state. Tests only. */
export function __resetStableReadRequestsForTests(): void {
  for (const entry of stableReadRequests.values()) {
    if (entry.abortTimer !== null) clearTimeout(entry.abortTimer);
    if (!entry.settled) entry.controller.abort();
  }
  stableReadRequests.clear();
  for (const cached of stableReadResults.values()) {
    clearTimeout(cached.evictTimer);
  }
  stableReadResults.clear();
}

export function strictModeStableReadRequestKey(
  config: Pick<AxiosRequestConfig, "method" | "params" | "url">,
): string | null {
  const method = config.method?.toUpperCase() ?? "GET";
  if (method !== "GET" || typeof config.url !== "string") return null;
  if (!STRICT_MODE_STABLE_GET_PATHS.some((path) => config.url!.startsWith(path))) return null;
  return `${method} ${config.url}?${stableStringify(config.params)}`;
}

/**
 * Deduplicate concurrent GETs on StrictMode-sensitive endpoints while still
 * cancelling the underlying HTTP request once every subscriber has aborted.
 *
 * In development (`graceMs > 0`), a brief grace timer bridges React StrictMode's
 * immediate unmount→remount cycle so the remount attaches to the in-flight call.
 * When no remount arrives (or immediately in production where `graceMs === 0`),
 * the underlying `AbortController` aborts so Chromium's HTTP/1.1 connection pool
 * is never starved by orphaned `/api/git/*` requests.
 */
export function executeStableReadRequest<T>(
  dedupeKey: string,
  config: AxiosRequestConfig,
  execute: (requestConfig: AxiosRequestConfig) => Promise<T>,
  options: StableReadOptions,
): Promise<T> {
  if (config.signal?.aborted) {
    return Promise.reject(new CanceledError("canceled"));
  }
  const cached = readFreshCachedResult<T>(dedupeKey, options.resultTtlMs);
  if (cached !== undefined) return Promise.resolve(cached.value);

  const entry = getOrCreateInFlightRead(dedupeKey, config, execute, options.resultTtlMs);
  return subscribeToInFlightRead<T>(dedupeKey, entry, config.signal, options.graceMs);
}

function readFreshCachedResult<T>(
  dedupeKey: string,
  resultTtlMs: number,
): { value: T } | undefined {
  if (resultTtlMs <= 0) return undefined;
  const cached = stableReadResults.get(dedupeKey);
  if (!cached) return undefined;
  if (cached.expiresAt > Date.now()) return { value: cached.value as T };
  clearTimeout(cached.evictTimer);
  stableReadResults.delete(dedupeKey);
  return undefined;
}

function cacheStableReadResult(dedupeKey: string, value: unknown, resultTtlMs: number): void {
  const existing = stableReadResults.get(dedupeKey);
  if (existing) clearTimeout(existing.evictTimer);
  const cached: CachedStableReadResult = {
    expiresAt: Date.now() + resultTtlMs,
    value,
    evictTimer: setTimeout(() => {
      if (stableReadResults.get(dedupeKey) === cached) {
        stableReadResults.delete(dedupeKey);
      }
    }, resultTtlMs),
  };
  stableReadResults.set(dedupeKey, cached);
}

function getOrCreateInFlightRead<T>(
  dedupeKey: string,
  config: AxiosRequestConfig,
  execute: (requestConfig: AxiosRequestConfig) => Promise<T>,
  resultTtlMs: number,
): InFlightStableRead {
  const existing = stableReadRequests.get(dedupeKey);
  if (existing && !existing.settled) {
    if (existing.abortTimer !== null) {
      clearTimeout(existing.abortTimer);
      existing.abortTimer = null;
    }
    return existing;
  }

  const controller = new AbortController();
  const outcome: Promise<SettledOutcome<unknown>> = execute({
    ...config,
    signal: controller.signal,
  }).then(
    (value): SettledOutcome<unknown> => ({ ok: true, value }),
    (error: unknown): SettledOutcome<unknown> => ({ ok: false, error }),
  );
  const entry: InFlightStableRead = {
    controller,
    outcome,
    activeSubscribers: 0,
    abortTimer: null,
    settled: false,
  };
  stableReadRequests.set(dedupeKey, entry);

  void outcome.then((settled) => {
    entry.settled = true;
    if (entry.abortTimer !== null) {
      clearTimeout(entry.abortTimer);
      entry.abortTimer = null;
    }
    if (stableReadRequests.get(dedupeKey) === entry) {
      stableReadRequests.delete(dedupeKey);
    }
    if (settled.ok && resultTtlMs > 0) {
      cacheStableReadResult(dedupeKey, settled.value, resultTtlMs);
    }
    pruneExpiredStableReadResults();
  });

  return entry;
}

function subscribeToInFlightRead<T>(
  dedupeKey: string,
  entry: InFlightStableRead,
  callerSignal: GenericAbortSignal | undefined,
  graceMs: number,
): Promise<T> {
  entry.activeSubscribers += 1;

  return new Promise<T>((resolve, reject) => {
    let finished = false;
    let unsubscribeAbort: (() => void) | null = null;

    const detach = (): void => {
      if (unsubscribeAbort !== null) {
        unsubscribeAbort();
        unsubscribeAbort = null;
      }
    };

    const onCallerAbort = (): void => {
      if (finished) return;
      finished = true;
      detach();
      releaseSubscriber(dedupeKey, entry, graceMs);
      reject(new CanceledError("canceled"));
    };

    if (callerSignal) {
      if (callerSignal.aborted) {
        onCallerAbort();
        return;
      }
      unsubscribeAbort = addAbortListener(callerSignal, onCallerAbort);
    }

    void entry.outcome.then((settled) => {
      if (finished) return;
      finished = true;
      detach();
      entry.activeSubscribers = Math.max(0, entry.activeSubscribers - 1);
      if (settled.ok) resolve(settled.value as T);
      else reject(settled.error);
    });
  });
}

function releaseSubscriber(dedupeKey: string, entry: InFlightStableRead, graceMs: number): void {
  entry.activeSubscribers = Math.max(0, entry.activeSubscribers - 1);
  if (entry.activeSubscribers > 0 || entry.settled) return;

  const abortIfUnused = (): void => {
    entry.abortTimer = null;
    if (entry.activeSubscribers > 0 || entry.settled) return;
    if (stableReadRequests.get(dedupeKey) === entry) {
      stableReadRequests.delete(dedupeKey);
    }
    entry.controller.abort();
  };

  if (graceMs <= 0) {
    abortIfUnused();
    return;
  }
  if (entry.abortTimer === null) {
    entry.abortTimer = setTimeout(abortIfUnused, graceMs);
  }
}

function addAbortListener(signal: GenericAbortSignal, onAbort: () => void): () => void {
  if (typeof signal.addEventListener === "function") {
    signal.addEventListener("abort", onAbort, { once: true });
    return () => {
      signal.removeEventListener?.("abort", onAbort);
    };
  }
  const previous = signal.onabort;
  const handler = (...args: unknown[]): void => {
    previous?.(...args);
    onAbort();
  };
  signal.onabort = handler;
  return () => {
    if (signal.onabort === handler) signal.onabort = previous ?? null;
  };
}

function pruneExpiredStableReadResults(): void {
  if (stableReadResults.size === 0) return;
  const now = Date.now();
  for (const [key, entry] of stableReadResults) {
    if (entry.expiresAt <= now) {
      clearTimeout(entry.evictTimer);
      stableReadResults.delete(key);
    }
  }
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
