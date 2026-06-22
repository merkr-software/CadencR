/**
 * Web Push subscribe / unsubscribe flow for the PWA/remote shell.
 *
 * The presence of a stored push subscription IS the per-device opt-in (the
 * shared `notification_mode` setting is left alone, so a phone can't clobber the
 * desktop's choice). All failures throw with a user-facing message; the settings
 * UI surfaces them as toasts — nothing is swallowed.
 */

import { subscribe, unsubscribe, vapidKey } from "@/api/generated";
import { detectStandalone } from "@/hooks/useFullscreen";
import { isPushSupported } from "@/lib/remote/push-register";

/** Remembers which VAPID key the active subscription was made with, so we can
 *  detect server-side key rotation and resubscribe instead of pushing in vain. */
const VAPID_KEY_STORAGE = "cadencr.pushVapidKey";

export type PushState = "unsupported" | "ios-needs-install" | "denied" | "off" | "on";

/** iOS only delivers Web Push to a home-screen-installed PWA (16.4+). A plain
 *  Safari tab can't, so we steer the user to "Add to Home Screen" instead. */
function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS reports as a Mac; disambiguate via touch support.
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

/** Whether this device can never receive push until installed to the homescreen. */
export function iosNeedsInstall(): boolean {
  return isIos() && !detectStandalone();
}

/** Current notification permission, or "default" when unavailable. */
export function pushPermission(): NotificationPermission {
  if (typeof Notification === "undefined") return "denied";
  return Notification.permission;
}

/** Resolve the current high-level push state for the settings UI. */
export async function getPushState(): Promise<PushState> {
  if (!isPushSupported()) return "unsupported";
  if (iosNeedsInstall()) return "ios-needs-install";
  if (pushPermission() === "denied") return "denied";
  const sub = await getActiveSubscription();
  return sub ? "on" : "off";
}

async function getActiveSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/**
 * Enable push on this device: request permission, subscribe via the VAPID key,
 * and register the subscription with the backend. Resubscribes transparently
 * when the server's VAPID key has rotated since the last subscription.
 */
export async function enablePush(): Promise<void> {
  if (!isPushSupported()) {
    throw new Error("Push notifications aren't supported in this browser.");
  }
  if (iosNeedsInstall()) {
    throw new Error("On iOS, add Cadencr to your Home Screen first, then enable push.");
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted.");
  }

  const reg = await navigator.serviceWorker.ready;
  const { public_key: vapidPublicKey } = await vapidKey();

  let sub = await reg.pushManager.getSubscription();
  // Server key rotated (or never recorded) → drop the stale subscription and
  // make a fresh one keyed to the current public key.
  if (sub && readStoredKey() !== vapidPublicKey) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    });
  }

  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error("The browser returned an incomplete push subscription.");
  }
  await subscribe({
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  });
  writeStoredKey(vapidPublicKey);
}

/** Disable push on this device: tell the backend to forget it, then unsubscribe. */
export async function disablePush(): Promise<void> {
  const sub = await getActiveSubscription();
  if (sub) {
    // Backend first: if it fails we keep the browser subscription so a retry can
    // still clean up the server row (avoids a dangling endpoint we'd push to).
    await unsubscribe({ endpoint: sub.endpoint });
    await sub.unsubscribe();
  }
  clearStoredKey();
}

function readStoredKey(): string | null {
  try {
    return localStorage.getItem(VAPID_KEY_STORAGE);
  } catch {
    return null;
  }
}

function writeStoredKey(key: string): void {
  try {
    localStorage.setItem(VAPID_KEY_STORAGE, key);
  } catch {
    // Best-effort: a blocked store just means we'll resubscribe next time.
  }
}

function clearStoredKey(): void {
  try {
    localStorage.removeItem(VAPID_KEY_STORAGE);
  } catch {
    // Nothing to clear.
  }
}

/** Decode a base64url VAPID key into the `Uint8Array` `pushManager` expects. */
function urlBase64ToUint8Array(base64UrlString: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64UrlString.length % 4)) % 4);
  const base64 = (base64UrlString + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  // Back the array with a concrete `ArrayBuffer` (not `ArrayBufferLike`) so it
  // satisfies `applicationServerKey`'s `BufferSource` type.
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}
