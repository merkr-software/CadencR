/*
 * Cadencr service worker — Web Push for the installed PWA / remote browser only.
 *
 * It is registered exclusively from the web shell (never the Electron desktop
 * shell — see `lib/remote/push-register.ts`). Its only jobs are showing a native
 * notification when the backend pushes one (agent finished / needs input) and
 * routing a click back to the right session. It deliberately does NOT cache app
 * assets: the SPA is served fresh by the host and offline use isn't a goal here.
 */

// Activate immediately on first install / update so a returning PWA picks up a
// new worker without waiting for every tab to close.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// `userVisibleOnly: true` (mandatory on Chromium) means every push MUST show a
// notification. The payload is the JSON the backend's push dispatcher sends.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || "Cadencr";
  const options = {
    body: data.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    // Collapse repeated notifications for the same feature into one.
    tag: data.feature_id != null ? `cadencr-feature-${data.feature_id}` : undefined,
    renotify: data.feature_id != null,
    data: { feature_id: data.feature_id ?? null, project_id: data.project_id ?? null },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Focus an already-open client (the common backgrounded-tab case) and tell it
// which session to open; only fall back to opening a fresh window when none
// exists (the app was fully closed).
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { feature_id, project_id } = event.notification.data || {};
  event.waitUntil(focusOrOpen(feature_id, project_id));
});

async function focusOrOpen(featureId, projectId) {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const client = all.find((c) => "focus" in c);
  if (client) {
    await client.focus();
    client.postMessage({ type: "cadencr-notification-click", featureId, projectId });
    return;
  }
  // Cold start: open the root with the target encoded so the app navigates after
  // it mounts (see `lib/remote/push-register.ts`).
  if (self.clients.openWindow) {
    const params = new URLSearchParams();
    if (featureId != null) params.set("notifFeature", String(featureId));
    if (projectId != null) params.set("notifProject", String(projectId));
    const query = params.toString();
    await self.clients.openWindow(`/${query ? `?${query}` : ""}`);
  }
}
