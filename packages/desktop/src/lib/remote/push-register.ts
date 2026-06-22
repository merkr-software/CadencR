/**
 * Service-worker registration + push-click navigation for the PWA/remote shell.
 *
 * Strictly web-only: the Electron desktop shell already has native OS
 * notifications, so we never register a worker there (guarded on
 * `isBrowserRemote()`). Registration is side-effect-free w.r.t. permissions —
 * actually subscribing to push is a separate, user-gesture-driven flow in
 * settings (`push-subscribe.ts`).
 */

import type { QueryClient } from "@tanstack/react-query";
import { openSessionFromPush } from "@/lib/notify-agent-done";
import { isBrowserRemote } from "@/lib/remote/device-token";

const SW_URL = "/sw.js";

/** True when the runtime can do Web Push at all. */
export function isPushSupported(): boolean {
  return (
    isBrowserRemote() &&
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * Register the service worker (idempotent — the browser dedupes by URL). No-op
 * outside the remote browser. Failures are logged but never throw: a missing
 * worker just means no background push, which the settings UI surfaces.
 */
export async function registerPushServiceWorker(): Promise<void> {
  if (!isPushSupported()) return;
  try {
    await navigator.serviceWorker.register(SW_URL);
  } catch (err) {
    console.error("[push] service worker registration failed:", err);
  }
}

type NavigateFn = Parameters<typeof openSessionFromPush>[0];

/**
 * Wire push-click navigation, returning a cleanup fn for `useEffect`:
 *  - a focused/backgrounded tab receives a `postMessage` from the worker;
 *  - a cold-started PWA carries `?notifFeature/&notifProject` on the URL.
 * Both route to the same session via the shared notification navigation.
 */
export function listenForPushNavigation(
  navigate: NavigateFn,
  queryClient: QueryClient,
): () => void {
  if (!isPushSupported()) return () => undefined;

  consumeColdStartTarget(navigate, queryClient);

  const onMessage = (event: MessageEvent) => {
    const data = event.data as
      | { type?: string; featureId?: number | null; projectId?: number | null }
      | undefined;
    if (data?.type !== "cadencr-notification-click") return;
    if (typeof data.featureId === "number" && typeof data.projectId === "number") {
      openSessionFromPush(navigate, queryClient, data.featureId, data.projectId);
    }
  };
  navigator.serviceWorker.addEventListener("message", onMessage);
  return () => navigator.serviceWorker.removeEventListener("message", onMessage);
}

/** Cold-start deep link: navigate to the encoded target, then strip the params. */
function consumeColdStartTarget(navigate: NavigateFn, queryClient: QueryClient): void {
  const params = new URLSearchParams(location.search);
  const featureId = Number(params.get("notifFeature"));
  const projectId = Number(params.get("notifProject"));
  if (!Number.isFinite(featureId) || featureId <= 0) return;

  openSessionFromPush(navigate, queryClient, featureId, Number.isFinite(projectId) ? projectId : 0);
  params.delete("notifFeature");
  params.delete("notifProject");
  const query = params.toString();
  history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
}
