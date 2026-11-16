import { app, Notification, type BrowserWindow } from "electron";
import { sendToWindow } from "./safe-send";

export type NotifyMode = "native" | "in_app";

export interface NotifyOptions {
  title: string;
  body: string;
  featureId: number;
  projectId: number;
  routeType: "session";
  mode: NotifyMode;
}

export function notificationPermission(): boolean {
  // `isSupported()` only confirms the OS *can* show notifications; it cannot
  // tell us whether the user has authorized them (macOS exposes no such API).
  // Real authorization failures are surfaced asynchronously via `notification-failed`.
  return Notification.isSupported();
}

export function sendNotification(mainWindow: BrowserWindow, opts: NotifyOptions): void {
  if (shouldRenderInApp(opts.mode)) {
    sendToWindow(mainWindow, "notification-fallback", {
      title: opts.title,
      body: opts.body,
      click: {
        feature_id: opts.featureId,
        project_id: opts.projectId,
        route_type: opts.routeType,
      },
    });
    return;
  }
  showNotification(mainWindow, opts.title, opts.body, () => {
    sendNotificationClick(mainWindow, opts);
  });
}

/** Open a conversation in the app renderer, as a notification click does. */
export function sendNotificationClick(
  mainWindow: BrowserWindow,
  ref: { featureId: number; projectId: number },
): void {
  sendToWindow(mainWindow, "notification-clicked", {
    feature_id: ref.featureId,
    project_id: ref.projectId,
    route_type: "session",
  });
}

/**
 * The test button is a diagnostic tool, not the agent-finished pipeline.
 * In dev the bundle identity is wrong, so we fall back to the in-app
 * toast — otherwise we always try the native path regardless of the
 * user's saved preference.
 */
export function sendTestNotification(mainWindow: BrowserWindow): void {
  const title = "Cadencr test notification";
  const body = "If you can see this, system notifications are working.";
  if (!app.isPackaged) {
    sendToWindow(mainWindow, "notification-fallback", { title, body, click: null });
    return;
  }
  showNotification(mainWindow, title, body);
}

/**
 * In-app fallback wins when either:
 *
 * - The user picked "in app" in Settings → Notifications, or
 * - We're running in dev (`!app.isPackaged`). The dev binary's bundle id
 *   is `com.github.Electron`, not `com.cadencr.desktop`, so a native
 *   banner would be attributed to "Electron" — confusing and unrepresentative.
 *
 * The dev override applies regardless of the saved setting, by design.
 */
function shouldRenderInApp(mode: NotifyMode): boolean {
  return !app.isPackaged || mode === "in_app";
}

function showNotification(
  mainWindow: BrowserWindow,
  title: string,
  body: string,
  onClick?: () => void,
): void {
  if (!Notification.isSupported()) {
    sendToWindow(mainWindow, "notification-failed", {
      reason: "Notifications are not supported on this system.",
    });
    return;
  }
  // Cadencr is an IDE — agent-finished pings every few minutes shouldn't make a noise.
  const notification = new Notification({ title, body, silent: true });
  if (onClick) notification.on("click", onClick);
  notification.on("failed", (_event, error) => {
    sendToWindow(mainWindow, "notification-failed", { reason: friendlyFailureReason(error) });
  });
  notification.show();
}

/**
 * Translate raw macOS notification errors into something the user can act
 * on. Per the Electron docs, unsigned macOS binaries can't deliver to
 * Notification Center; macOS reports this as `UNErrorDomain error 1`
 * (`UNErrorCodeNotificationsNotAllowed`). Leave other errors (Focus mode,
 * "denied", …) verbatim so we don't hide useful detail.
 */
export function friendlyFailureReason(rawError: string | undefined): string {
  const error = rawError && rawError.length > 0 ? rawError : "Unknown error";
  if (error.includes("UNErrorDomain error 1") || error.includes("UNErrorDomain Code=1")) {
    return "macOS refused to deliver this notification because the app isn't code-signed. Use the production build, or rebuild locally so an ad-hoc signature is applied.";
  }
  return error;
}
