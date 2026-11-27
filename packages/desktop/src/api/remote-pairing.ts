/**
 * Remote-browser pairing bootstrap.
 *
 * The host generates a QR/link of the form
 * `https://<lan-ip>:<port>/#code=<pairing-code>`. When the SPA loads with that
 * `#code=`, we exchange it — over TLS, before React mounts — for a device
 * token. Strip the code before any network request, then persist the token session-only so a
 * refresh or a forwarded link can't replay a single-use code. Whether to *stay*
 * signed in is decided on this device (the pairing screen's switch, or the
 * post-pair toast after a link), never encoded in the host's link — so
 * forwarding a link can't silently make the wrong browser persistent.
 *
 * Runs before `preloadRuntimeConfig()` so the token is in place when the API
 * client first reads it. No-op in the desktop shell, and a no-op (beyond URL
 * cleanup) when no code is present — an already-paired device just reuses its
 * stored token.
 */

import { isBrowserRemote, writeDeviceToken } from "@/lib/remote/device-token";
import {
  PairingError,
  pairingIssueFromError,
  parsePairingIssue,
  type PairingIssue,
} from "@/lib/remote/pairing-errors";
import { z } from "zod";

const CODE_PARAM = "code";
/** The characters a pairing code is made of (URL-safe base64). */
export const PAIRING_CODE_PATTERN = /^[A-Za-z0-9_-]+$/;
/** Legacy host-side trust flag; no longer honored, just stripped from the URL. */
const TRUST_PARAM = "trust";

/** Set when pairing fails so the app can present the failure once React mounts. */
const PAIRING_ERROR_KEY = "cadencr.remotePairingError";
let unstoredPairingError: PairingIssue | null = null;

/** Set after a successful pair so the app can offer "stay signed in" once mounted. */
const JUST_PAIRED_KEY = "cadencr.remoteJustPaired";

export interface PairRemoteDeviceResult {
  storagePersisted: boolean;
}

/**
 * How a device paired, for the post-pair toast:
 * - `"session"` — session-only from a link (the Safari `#code=` flow); the
 *   toast offers to "stay signed in".
 * - `"session-chosen"` — session-only because the user turned "Stay signed in"
 *   off on the pairing screen; the toast does not ask again.
 * - `"trusted"` — the device opted into `localStorage`; the toast confirms
 *   that sign-in will persist.
 */
export type JustPairedMode = "session" | "session-chosen" | "trusted";

/**
 * Exchange a short-lived pairing code for a device token and persist it using
 * the requested trust level. Shared by the boot-time `#code=` flow and the
 * manual re-pairing gate so token parsing, errors, and storage behavior stay
 * identical — including flagging the post-pair toast, so the gate path (the
 * only one a homescreen PWA ever takes) surfaces feedback too.
 */
export async function pairRemoteDevice(
  code: string,
  options: { trust: boolean; chosen?: boolean } = { trust: false },
): Promise<PairRemoteDeviceResult> {
  const resp = await fetch(`${location.origin}/api/remote/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!resp.ok) {
    throw new PairingError(
      resp.status === 400
        ? { kind: "expired" }
        : resp.status === 429
          ? { kind: "rateLimited" }
          : { kind: "http", status: resp.status },
    );
  }
  const body = z
    .object({ device_token: z.string().min(1), label: z.string() })
    .safeParse(await resp.json());
  if (!body.success) {
    throw new PairingError({ kind: "malformedResponse" });
  }
  const storagePersisted = writeDeviceToken(body.data.device_token, options.trust);
  // Only flag the toast when the token actually persisted — otherwise the
  // caller surfaces a storage-blocked error instead. The flag lives in
  // sessionStorage, which survives the gate's `location.reload()`.
  if (storagePersisted) {
    flagJustPaired(options.trust ? "trusted" : options.chosen ? "session-chosen" : "session");
  }
  return { storagePersisted };
}

/** What the address held for pairing, once read and scrubbed (`takeUrlPairingCode`). */
type UrlPairingCode =
  | { kind: "none" }
  | { kind: "code"; code: string }
  | { kind: "error"; issue: PairingIssue };

/**
 * Reads a pairing code from the address (`#code=` or a legacy `?code=`) and
 * scrubs it, with any legacy trust flag, before anything can send it: the
 * code is single-use, so it must not linger in history or reach a request's
 * Referer. Used at boot (`ensurePaired`) and by the pairing screen when a new
 * link only changes the hash of a tab already showing it (`hashchange`, no
 * reload). An address it could not clean is an error and its code is dropped.
 */
export function takeUrlPairingCode(): UrlPairingCode {
  const query = new URLSearchParams(location.search);
  const fragment = pairingFragment(location.hash);
  const code = fragment.params.get(CODE_PARAM) || query.get(CODE_PARAM);
  const hasPairingParams = [query, fragment.params].some(
    (params) => params.has(CODE_PARAM) || params.has(TRUST_PARAM),
  );
  if (!hasPairingParams) return { kind: "none" };
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
    return { kind: "error", issue: { kind: "unsafeAddress" } };
  }
  if (!code) return { kind: "none" };
  if (!PAIRING_CODE_PATTERN.test(code)) {
    return { kind: "error", issue: { kind: "malformedCode" } };
  }
  return { kind: "code", code };
}

export async function ensurePaired(): Promise<void> {
  if (!isBrowserRemote()) return;
  const taken = takeUrlPairingCode();
  if (taken.kind === "error") {
    stashPairingError(taken.issue);
    return;
  }
  if (taken.kind === "none") return;

  try {
    // Session-only by default. The "stay signed in" opt-in happens on this
    // device after mount; `pairRemoteDevice` flags the toast when the token
    // persisted, so we only handle the storage-blocked case here.
    const paired = await pairRemoteDevice(taken.code, { trust: false });
    if (!paired.storagePersisted) {
      stashPairingError({ kind: "storageBlocked" });
    }
  } catch (err) {
    // The app mounts and presents failures from stale or bad codes.
    stashPairingError(pairingIssueFromError(err));
  }
}

/** Pop the one-shot pairing error (consumed once by the app after mount). */
export function takePairingError(): PairingIssue | null {
  const error = unstoredPairingError;
  unstoredPairingError = null;
  const stored = takeFlag(PAIRING_ERROR_KEY);
  return error ?? (stored ? parsePairingIssue(stored) : null);
}

/**
 * Pop the one-shot "just paired" flag, immediately after a fresh pair, so the
 * app can offer to keep this device signed in (`"session"`) or confirm it's
 * already persistent (`"trusted"`). `null` when there's nothing to replay.
 */
export function takeJustPaired(): JustPairedMode | null {
  const value = takeFlag(JUST_PAIRED_KEY);
  return value === "session" || value === "session-chosen" || value === "trusted" ? value : null;
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

function stashPairingError(error: PairingIssue): void {
  try {
    sessionStorage.setItem(PAIRING_ERROR_KEY, JSON.stringify(error));
  } catch {
    // The current mount can still report the problem when storage is blocked.
    unstoredPairingError = error;
  }
  console.error("[remote-pairing]", error);
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

/** The code a pairing link carries, in its fragment or (legacy) its query. */
function codeInUrl(url: URL): string | null {
  const code = pairingFragment(url.hash).params.get(CODE_PARAM) || url.searchParams.get(CODE_PARAM);
  return code && PAIRING_CODE_PATTERN.test(code) ? code : null;
}

/** Accept current fragment links, legacy query links, or a raw URL-safe code. */
export function extractPairingCode(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value, "https://pairing.invalid/");
  } catch {
    return null;
  }
  if (pairingFragment(url.hash).pairing || url.searchParams.has(CODE_PARAM)) return codeInUrl(url);
  return PAIRING_CODE_PATTERN.test(value) ? value : null;
}

/**
 * The code a scanned QR carries, only when it is a pairing link (an absolute
 * URL with a `code`): any other QR in view is not mistaken for a bare code.
 */
export function pairingCodeFromScan(text: string): string | null {
  try {
    return codeInUrl(new URL(text.trim()));
  } catch {
    return null;
  }
}

/**
 * The link a host's QR encodes: `address` (a listener URL) with `code` in its
 * fragment, so the code never reaches a server log or a Referer.
 */
export function pairingLink(address: string, code: string): string {
  const link = new URL(address);
  link.searchParams.delete(CODE_PARAM);
  link.searchParams.delete(TRUST_PARAM);
  link.hash = `${CODE_PARAM}=${encodeURIComponent(code)}`;
  return link.toString();
}
