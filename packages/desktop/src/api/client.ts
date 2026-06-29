import Axios, {
  type AxiosError,
  type AxiosRequestConfig,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
import { desktopBridge } from "@/lib/desktop-bridge";
import { clearDeviceToken, isBrowserRemote, readDeviceToken } from "@/lib/remote/device-token";

export interface RuntimeConfig {
  baseUrl: string;
  authToken: string | null;
}

const DEFAULT_DEV_BASE_URL = "http://127.0.0.1:5005";

let runtimeConfig: RuntimeConfig | null = null;
let runtimeConfigPromise: Promise<RuntimeConfig> | null = null;

function envFallback(): RuntimeConfig {
  const baseUrl = import.meta.env.VITE_API_URL;
  const authToken = import.meta.env.VITE_API_TOKEN;
  return {
    baseUrl:
      typeof baseUrl === "string" && baseUrl.length > 0
        ? baseUrl.replace(/\/$/, "")
        : DEFAULT_DEV_BASE_URL,
    authToken: typeof authToken === "string" && authToken.length > 0 ? authToken : null,
  };
}

async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  // Remote browser: the SPA is served over HTTPS by the same Rust listener it
  // talks to, so the API is same-origin and the credential is the paired
  // device token. Must NOT fall through to `envFallback()` below — that points
  // at the local dev port (`127.0.0.1:5005`), which a remote device can't reach
  // and which would leak the wrong base URL into every request.
  if (isBrowserRemote()) {
    return { baseUrl: location.origin, authToken: readDeviceToken() };
  }

  const fallback = envFallback();
  try {
    const result = await desktopBridge.runtimeConfig();
    if (result && typeof result.baseUrl === "string") {
      return {
        baseUrl: result.baseUrl,
        authToken: result.authToken ?? fallback.authToken,
      };
    }
  } catch (err) {
    console.warn("[runtime-config] desktop runtime config unavailable:", err);
  }
  return fallback;
}

/** Call once at boot before mounting so sync accessors see a populated cache. */
export async function preloadRuntimeConfig(): Promise<RuntimeConfig> {
  if (runtimeConfig) return runtimeConfig;
  if (!runtimeConfigPromise) {
    runtimeConfigPromise = loadRuntimeConfig().then((cfg) => {
      runtimeConfig = cfg;
      return cfg;
    });
  }
  return runtimeConfigPromise;
}

export function getRuntimeConfigSync(): RuntimeConfig {
  return runtimeConfig ?? envFallback();
}

export function resolveApiBaseUrlSync(): string {
  return getRuntimeConfigSync().baseUrl;
}

export function getAuthTokenSync(): string | null {
  // In a remote browser the device token can change mid-session — revoked on
  // the host (→ 401 → cleared) or re-paired — so read it live instead of the
  // value frozen into the runtime config at boot. The loopback launch token
  // never changes, so there the cached value is correct.
  if (isBrowserRemote()) return readDeviceToken();
  return getRuntimeConfigSync().authToken;
}

/** Reset cached runtime config. Tests only. */
export function __resetRuntimeConfigForTests(): void {
  runtimeConfig = null;
  runtimeConfigPromise = null;
}

const axiosInstance = Axios.create({ timeout: 30000 });

// `main.tsx` awaits preload before mounting, so sync accessors are always
// populated by the time a request fires.
axiosInstance.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  if (!config.baseURL) {
    config.baseURL = resolveApiBaseUrlSync();
  }
  const token = getAuthTokenSync();
  if (token) {
    config.headers.set("X-Cadencr-Token", token);
  }
  return config;
});

// In a remote browser, a 401 means the paired device token is no longer valid
// (revoked on the host, or expired). Drop it so we stop presenting a dead
// credential — the user can re-pair with a fresh code. Harmless on loopback,
// where the launch token never 401s mid-session.
axiosInstance.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    if (error.response?.status === 401 && isBrowserRemote()) {
      clearDeviceToken();
    }
    return Promise.reject(error);
  },
);

/**
 * Endpoints that drive long-running processes. The 30 s default is way too
 * tight for these:
 * - `/api/git/commit` fires pre-commit hooks (full test suite easily ≥ minutes).
 * - `/api/git/push` waits on remote network.
 * - `/api/lsp/sessions` may trigger a 30 MB+ rust-analyzer download on the
 *   first open in a Rust workspace. The backend has its own 5-min download
 *   timeout; the renderer just needs to not give up on the POST first.
 *
 * For these calls we disable the timeout entirely.
 */
const NO_TIMEOUT_PATHS = ["/api/git/commit", "/api/git/push", "/api/lsp/sessions"];
const STRICT_MODE_STABLE_GET_PATHS = ["/api/git/", "/api/feature-layouts"];
const STRICT_MODE_STABLE_RESULT_TTL_MS = 250;
const stableReadRequests = new Map<string, Promise<unknown>>();
const stableReadResults = new Map<string, { expiresAt: number; value: unknown }>();
const WORKSPACE_SETTINGS_PATH = "/api/workspace/settings";
const WORKSPACE_SETTINGS_SINGLE_PREFIX = `${WORKSPACE_SETTINGS_PATH}/`;
const WORKSPACE_SETTINGS_BULK_RESULT_TTL_MS = 500;
let workspaceSettingsBulkRequest: Promise<unknown> | null = null;
let workspaceSettingsBulkResult: { expiresAt: number; value: unknown } | null = null;

interface WorkspaceSettingEntry {
  key: string;
  value: string;
}

interface WorkspaceSettingValue {
  value: string | null;
}

export function shouldAttachAbortSignal(
  config: Pick<AxiosRequestConfig, "method" | "signal" | "url">,
): boolean {
  if (config.signal === undefined) return true;
  const method = config.method?.toUpperCase() ?? "GET";
  if (method !== "GET" || typeof config.url !== "string") return true;
  return !STRICT_MODE_STABLE_GET_PATHS.some((path) => config.url!.startsWith(path));
}

export function strictModeStableReadRequestKey(
  config: Pick<AxiosRequestConfig, "method" | "params" | "url">,
): string | null {
  const method = config.method?.toUpperCase() ?? "GET";
  if (method !== "GET" || typeof config.url !== "string") return null;
  if (!STRICT_MODE_STABLE_GET_PATHS.some((path) => config.url!.startsWith(path))) return null;
  return `${method} ${config.url}?${stableStringify(config.params)}`;
}

export async function customInstance<T>(config: AxiosRequestConfig): Promise<T> {
  let finalConfig =
    typeof config.url === "string" && NO_TIMEOUT_PATHS.some((p) => config.url!.startsWith(p))
      ? { ...config, timeout: 0 }
      : config;
  if (!shouldAttachAbortSignal(finalConfig)) {
    finalConfig = { ...finalConfig, signal: undefined };
  }
  const workspaceSettingKey = workspaceSingleSettingKey(finalConfig);
  if (workspaceSettingKey) {
    const cachedSetting = await workspaceSettingFromBulkRequest(workspaceSettingKey);
    if (cachedSetting !== undefined) return cachedSetting as T;
  }
  if (isWorkspaceSettingsBulkGet(finalConfig)) {
    return (await fetchWorkspaceSettingsBulk(finalConfig)) as T;
  }
  const dedupeKey = strictModeStableReadRequestKey(finalConfig);
  if (dedupeKey) {
    const now = Date.now();
    const cached = stableReadResults.get(dedupeKey);
    if (cached && cached.expiresAt > now) return cached.value as T;
    if (cached) stableReadResults.delete(dedupeKey);
    const existing = stableReadRequests.get(dedupeKey);
    if (existing) return (await existing) as T;
    const request = axiosInstance(finalConfig).then((response) => response.data as T);
    stableReadRequests.set(dedupeKey, request);
    try {
      const result = await request;
      stableReadResults.set(dedupeKey, {
        expiresAt: Date.now() + STRICT_MODE_STABLE_RESULT_TTL_MS,
        value: result,
      });
      return result;
    } finally {
      stableReadRequests.delete(dedupeKey);
      // Prune in `finally` so error paths also bound map growth — one entry
      // per unique cached path would otherwise leak across a long session.
      pruneExpiredStableReadResults();
    }
  }
  const response = await axiosInstance(finalConfig);
  return response.data;
}

function isWorkspaceSettingsBulkGet(config: Pick<AxiosRequestConfig, "method" | "url">): boolean {
  const method = config.method?.toUpperCase() ?? "GET";
  return method === "GET" && config.url === WORKSPACE_SETTINGS_PATH;
}

function workspaceSingleSettingKey(
  config: Pick<AxiosRequestConfig, "method" | "url">,
): string | null {
  const method = config.method?.toUpperCase() ?? "GET";
  if (method !== "GET" || typeof config.url !== "string") return null;
  if (!config.url.startsWith(WORKSPACE_SETTINGS_SINGLE_PREFIX)) return null;
  const key = config.url.slice(WORKSPACE_SETTINGS_SINGLE_PREFIX.length);
  return key.length > 0 && !key.includes("/") ? decodeURIComponent(key) : null;
}

async function workspaceSettingFromBulkRequest(
  key: string,
): Promise<WorkspaceSettingValue | undefined> {
  const cached = workspaceSettingsBulkResult;
  if (cached && cached.expiresAt > Date.now()) return workspaceSettingFromBulk(cached.value, key);
  if (!workspaceSettingsBulkRequest) return undefined;
  return workspaceSettingFromBulk(await workspaceSettingsBulkRequest, key);
}

async function fetchWorkspaceSettingsBulk(config: AxiosRequestConfig): Promise<unknown> {
  if (workspaceSettingsBulkRequest) return workspaceSettingsBulkRequest;
  const request = axiosInstance(config).then((response) => response.data as unknown);
  workspaceSettingsBulkRequest = request;
  try {
    const result = await request;
    workspaceSettingsBulkResult = {
      expiresAt: Date.now() + WORKSPACE_SETTINGS_BULK_RESULT_TTL_MS,
      value: result,
    };
    return result;
  } finally {
    workspaceSettingsBulkRequest = null;
  }
}

export function workspaceSettingFromBulk(
  settings: unknown,
  key: string,
): WorkspaceSettingValue | undefined {
  if (!isWorkspaceSettingEntryArray(settings)) return undefined;
  const entry = settings.find((item) => item.key === key);
  return { value: entry?.value ?? null };
}

function isWorkspaceSettingEntryArray(value: unknown): value is WorkspaceSettingEntry[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        "key" in item &&
        "value" in item &&
        typeof item.key === "string" &&
        typeof item.value === "string",
    )
  );
}

function pruneExpiredStableReadResults(): void {
  const now = Date.now();
  for (const [key, entry] of stableReadResults) {
    if (entry.expiresAt <= now) stableReadResults.delete(key);
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

/**
 * Lightweight backend liveness probe. Used by the connection-status store
 * (periodic poll) and the connection watchdog (post-wake / post-online check).
 *
 * Resolves with `{ ok: true }` on a 2xx, `{ ok: false, reason }` otherwise.
 * Never throws — callers always receive a verdict so the status state machine
 * can stay in a known shape (no orphaned promises after a wake/sleep).
 *
 * The 5 s timeout is shorter than the default 30 s on purpose: a hung backend
 * should flip the indicator within a few seconds, not half a minute.
 */
export async function pingHealth(): Promise<
  { ok: true } | { ok: false; reason: string; retryAfterMs?: number }
> {
  try {
    await axiosInstance.get("/api/health", { timeout: 5000 });
    return { ok: true };
  } catch (err) {
    const axiosErr = err as AxiosError;
    if (axiosErr.code === "ECONNABORTED") {
      return { ok: false, reason: "Backend not responding (timed out)" };
    }
    if (axiosErr.code === "ERR_NETWORK") {
      return { ok: false, reason: "Backend unreachable" };
    }
    if (axiosErr.response) {
      // A 429 means the per-IP rate limit tripped (remote access). Surface the
      // Retry-After so reconnect logic can back off instead of hammering it.
      if (axiosErr.response.status === 429) {
        return {
          ok: false,
          reason: "Backend rate limit reached; backing off",
          retryAfterMs: parseRetryAfterMs(axiosErr.response.headers),
        };
      }
      return {
        ok: false,
        reason: `Backend returned ${axiosErr.response.status} ${axiosErr.response.statusText}`,
      };
    }
    return { ok: false, reason: axiosErr.message ?? "Backend unreachable" };
  }
}

/** Parse a `Retry-After` (seconds) header into millis; defaults to one window. */
function parseRetryAfterMs(headers: AxiosResponse["headers"]): number {
  const secs = Number(headers["retry-after"]);
  if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, 120_000);
  return 60_000;
}

export type ErrorType<T> = AxiosError<T>;
