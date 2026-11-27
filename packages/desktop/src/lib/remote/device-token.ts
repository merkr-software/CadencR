/**
 * Device-token storage for remote-browser sessions.
 *
 * When Cadencr's SPA is loaded over HTTPS from another device there is no
 * Electron preload bridge and no per-launch token — the device token paired
 * via `POST /api/remote/pair` is the only credential. It lives in
 * `sessionStorage` by default (gone when the tab closes) and is promoted to
 * `localStorage` only when the user opted into "Trust this device" at pairing,
 * so the token survives to a returning device.
 */

const DEVICE_TOKEN_KEY = "cadencr.remoteDeviceToken";

/**
 * In-memory source of truth for the current device token. Storage is just the
 * durable mirror: holding it here means a 401-driven `clearDeviceToken()` takes
 * effect on the very next request (the API client reads this live), and a
 * freshly paired token still works for the session even if storage is blocked
 * (private mode). `undefined` means "not yet read from storage".
 */
let memoryToken: string | null | undefined;
const revocationListeners = new Set<() => void>();

export function subscribeToDeviceRevocation(notify: () => void): () => void {
  revocationListeners.add(notify);
  return () => revocationListeners.delete(notify);
}

/**
 * True when the SPA runs in a remote browser: a real browser served over
 * HTTPS with no Electron preload bridge. The desktop renderer loads from
 * `file://` and exposes `window.cadencr`, so this is `false` there.
 */
export function isBrowserRemote(): boolean {
  if (typeof window === "undefined" || typeof location === "undefined") return false;
  if (window.cadencr) return false;
  return location.protocol === "https:";
}

/** True when a remote browser is running without a foreground page. */
export function isHiddenBrowserRemote(): boolean {
  return isBrowserRemote() && typeof document !== "undefined" && document.hidden;
}

/**
 * Read the current device token: the in-memory value wins; otherwise it's
 * hydrated once from storage (a trusted `localStorage` token beats a
 * `sessionStorage` one). After hydration this is the live value, so revoke and
 * re-pair are reflected immediately without a reload.
 */
export function readDeviceToken(): string | null {
  if (memoryToken !== undefined) return memoryToken;
  if (typeof window === "undefined") return null;
  try {
    memoryToken =
      localStorage.getItem(DEVICE_TOKEN_KEY) ?? sessionStorage.getItem(DEVICE_TOKEN_KEY);
  } catch {
    memoryToken = null;
  }
  return memoryToken;
}

/**
 * Persist the device token. `trust` writes to `localStorage` (survives tab
 * close); otherwise `sessionStorage`. Either way the duplicate in the other
 * store is cleared so the trust choice has a single source of truth.
 *
 * The token is always set in memory first, so the session works even when
 * `false` is returned because storage is unavailable (e.g. private mode) — it
 * just won't persist across reloads, which is worth surfacing.
 */
export function writeDeviceToken(token: string, trust: boolean): boolean {
  memoryToken = token;
  if (typeof window === "undefined") return false;
  try {
    const [primary, secondary] = trust
      ? [localStorage, sessionStorage]
      : [sessionStorage, localStorage];
    primary.setItem(DEVICE_TOKEN_KEY, token);
    secondary.removeItem(DEVICE_TOKEN_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Promote the current device token to durable (`localStorage`) storage so it
 * survives closing the tab. Called when the user opts to stay signed in on this
 * device after pairing. Returns `false` (no-op) if there's no token or storage
 * is unavailable.
 */
export function trustCurrentDevice(): boolean {
  const token = readDeviceToken();
  return token ? writeDeviceToken(token, true) : false;
}

/** Forget the device token from memory and both stores (e.g. after a 401). */
export function clearDeviceToken(): void {
  const wasPaired = Boolean(readDeviceToken());
  memoryToken = null;
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(DEVICE_TOKEN_KEY);
    sessionStorage.removeItem(DEVICE_TOKEN_KEY);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
  if (wasPaired) {
    for (const notify of revocationListeners) notify();
  }
}

/** Reset the in-memory token cache. Tests only. */
export function __resetDeviceTokenMemoryForTests(): void {
  memoryToken = undefined;
}
