/**
 * Remote-browser pairing bootstrap.
 *
 * The host generates a QR/link of the form
 * `https://<lan-ip>:<port>/#code=<pairing-code>`. When the SPA loads with that
 * `#code=`, we exchange it — over TLS, before React mounts — for a device
 * token. Strip the code before any network request, then persist the token session-only so a
 * refresh or a forwarded link can't replay a single-use code. Whether to *stay*
 * signed in is decided on this device after pairing (see the post-pair toast),
 * not encoded in the host's link — so forwarding a link can't silently make the
 * wrong browser persistent.
 *
 * Runs before `preloadRuntimeConfig()` so the token is in place when the API
 * client first reads it. No-op in the desktop shell, and a no-op (beyond URL
 * cleanup) when no code is present — an already-paired device just reuses its
 * stored token.
 */

import { isBrowserRemote, writeDeviceToken } from "@/lib/remote/device-token";
import { z } from "zod";
import { apiErrorMessage } from "@/lib/api-errors";

const CODE_PARAM = "code";
/** Legacy host-side trust flag; no longer honored, just stripped from the URL. */
const TRUST_PARAM = "trust";

/** Set when pairing fails so the app can surface a toast once React mounts. */
const PAIRING_ERROR_KEY = "cadencr.remotePairingError";

/** Set after a successful pair so the app can offer "stay signed in" once mounted. */
const JUST_PAIRED_KEY = "cadencr.remoteJustPaired";

export interface PairRemoteDeviceResult {
  storagePersisted: boolean;
}

/**
 * How a device paired, for the post-pair toast:
 * - `"session"` — session-only (the Safari `#code=` flow); the toast offers to
 *   "stay signed in".
 * - `"trusted"` — the device explicitly opted into `localStorage`; the toast
 *   confirms that sign-in will persist.
 */
export type JustPairedMode = "session" | "trusted";

/**
 * Exchange a short-lived pairing code for a device token and persist it using
 * the requested trust level. Shared by the boot-time `#code=` flow and the
 * manual re-pairing gate so token parsing, errors, and storage behavior stay
 * identical — including flagging the post-pair toast, so the gate path (the
 * only one a homescreen PWA ever takes) surfaces feedback too.
 */
export async function pairRemoteDevice(
  code: string,
  options: { trust: boolean } = { trust: false },
): Promise<PairRemoteDeviceResult> {
  const resp = await fetch(`${location.origin}/api/remote/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!resp.ok) {
    throw new Error(pairingErrorMessage(resp.status));
  }
  const body = z
    .object({ device_token: z.string().min(1), label: z.string() })
    .safeParse(await resp.json());
  if (!body.success) {
    throw new Error("The pairing response was malformed.");
  }
  const storagePersisted = writeDeviceToken(body.data.device_token, options.trust);
  // Only flag the toast when the token actually persisted — otherwise the
  // caller surfaces a storage-blocked error instead. The flag lives in
  // sessionStorage, which survives the gate's `location.reload()`.
  if (storagePersisted) flagJustPaired(options.trust ? "trusted" : "session");
  return { storagePersisted };
}

function pairingErrorMessage(status: number): string {
  return status === 400
    ? "This pairing code has expired. Generate a fresh one on the host computer."
    : `Pairing failed (HTTP ${status}).`;
}

export async function ensurePaired(): Promise<void> {
  if (!isBrowserRemote()) return;
  const query = new URLSearchParams(location.search);
  const fragment = pairingFragment(location.hash);
  const code = fragment.params.get(CODE_PARAM) || query.get(CODE_PARAM);
  const hasPairingParams = [query, fragment.params].some(
    (params) => params.has(CODE_PARAM) || params.has(TRUST_PARAM),
  );
  if (!hasPairingParams) return;
  // A legacy query would otherwise reach the pairing request in Referer. Scrub
  // both URL forms before starting any request, including failed pair attempts.
  query.delete(CODE_PARAM);
  query.delete(TRUST_PARAM);
  fragment.params.delete(CODE_PARAM);
  fragment.params.delete(TRUST_PARAM);
  const search = query.toString();
  const hash = fragment.pairing ? fragment.cleaned() : location.hash;
  try {
    history.replaceState(null, "", `${location.pathname}${search ? `?${search}` : ""}${hash}`);
  } catch {
    stashPairingError(
      "Could not remove the pairing code from this page's address. Pairing was stopped.",
    );
    return;
  }
  if (!code) return;
  if (!/^[A-Za-z0-9_-]+$/.test(code)) {
    stashPairingError("The pairing code is malformed. Generate a new link on the host.");
    return;
  }

  try {
    // Session-only by default. The "stay signed in" opt-in happens on this
    // device after mount; `pairRemoteDevice` flags the toast when the token
    // persisted, so we only handle the storage-blocked case here.
    const paired = await pairRemoteDevice(code, { trust: false });
    if (!paired.storagePersisted) {
      stashPairingError(
        "Paired, but this browser blocks storage — you'll need to re-pair after a reload.",
      );
    }
  } catch (err) {
    // Pre-React: stash the message so the app can toast it after mount. We
    // still let the app load (an unauthenticated state the UI surfaces) rather
    // than blocking on a stale or bad code.
    stashPairingError(apiErrorMessage(err, "Pairing failed."));
  }
}

/** Pop the one-shot pairing error (consumed once by the app after mount). */
export function takePairingError(): string | null {
  return takeFlag(PAIRING_ERROR_KEY);
}

/**
 * Pop the one-shot "just paired" flag, immediately after a fresh pair, so the
 * app can offer to keep this device signed in (`"session"`) or confirm it's
 * already persistent (`"trusted"`). `null` when there's nothing to replay.
 */
export function takeJustPaired(): JustPairedMode | null {
  const value = takeFlag(JUST_PAIRED_KEY);
  return value === "session" || value === "trusted" ? value : null;
}

function takeFlag(key: string): string | null {
  try {
    const value = sessionStorage.getItem(key);
    if (value) sessionStorage.removeItem(key);
    return value;
  } catch {
    return null;
  }
}

function flagJustPaired(mode: JustPairedMode): void {
  try {
    sessionStorage.setItem(JUST_PAIRED_KEY, mode);
  } catch {
    // Offering the persistence opt-in is best-effort; nothing to surface.
  }
}

function stashPairingError(message: string): void {
  try {
    sessionStorage.setItem(PAIRING_ERROR_KEY, message);
  } catch {
    // Storage unavailable; the console error below is the only signal left.
  }
  console.error("[remote-pairing]", message);
}

function pairingFragment(hash: string): {
  params: URLSearchParams;
  pairing: boolean;
  cleaned: () => string;
} {
  const value = hash.replace(/^#/, "");
  const question = value.indexOf("?");
  const route = question >= 0 ? value.slice(0, question) : "";
  const params = new URLSearchParams(question >= 0 ? value.slice(question + 1) : value);
  const pairing = params.has(CODE_PARAM) || params.has(TRUST_PARAM);
  return {
    params,
    pairing,
    cleaned: () => {
      const rest = params.toString();
      const result = `${route}${route && rest ? "?" : ""}${rest}`;
      return result ? `#${result}` : "";
    },
  };
}

/** Accept current fragment links, legacy query links, or a raw URL-safe code. */
export function extractPairingCode(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  let code: string | null = null;
  try {
    const url = new URL(value, "https://pairing.invalid/");
    code = pairingFragment(url.hash).params.get(CODE_PARAM) || url.searchParams.get(CODE_PARAM);
  } catch {
    return null;
  }
  const candidate = code || value;
  return /^[A-Za-z0-9_-]+$/.test(candidate) ? candidate : null;
}
