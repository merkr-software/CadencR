import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  getGetWorkspaceSettingQueryKey,
  getListProjectsQueryKey,
  getMessagePreview,
  type Project,
  type SettingValueResponse,
} from "@/api/generated";
import { desktopBridge, type NotificationFallbackPayload } from "@/lib/desktop-bridge";
import { NOTIFICATION_MODE_KEY, parseNotificationMode } from "@/lib/notification-mode";
import { queryClient } from "@/lib/queryClient";
import { wsSessionIdFromFeature } from "@/lib/ws-session-id";

let permissionCache: boolean | null = null;

/**
 * Initialize notification permission check.
 * Must be called once at app startup before any notifications are sent.
 *
 * On macOS there is no programmatic API to query the user's notification
 * authorization state, so this only verifies the OS *supports* notifications
 * at all — it does not guarantee delivery. Authorization failures (denied
 * permission, Focus mode, missing entitlement) are surfaced asynchronously
 * via `listenForNotificationFailures`.
 */
export async function initNotificationPermission(): Promise<void> {
  try {
    permissionCache = await desktopBridge.notifyPermission();
  } catch {
    permissionCache = false;
  }
}

/**
 * Read the user's notification-mode preference from React Query's
 * workspace-settings cache. `useDebouncedSetting` writes through to this
 * cache synchronously on every change, so non-React callers stay in sync
 * without a separate module-level cache.
 */
export function readNotificationMode() {
  const cached = queryClient.getQueryData<SettingValueResponse>(
    getGetWorkspaceSettingQueryKey(NOTIFICATION_MODE_KEY),
  );
  return parseNotificationMode(cached?.value);
}

/**
 * Surface main-process notification failures (denied permission, Focus mode,
 * missing entitlement, …) as a toast so users aren't left wondering why
 * nothing fired. Returns a cleanup function for use in useEffect.
 */
export function listenForNotificationFailures(): () => void {
  return desktopBridge.onNotificationFailed((payload) => {
    toast.error("System notification was blocked", {
      description: payload.reason,
    });
  });
}

interface NotifyOptions {
  status: "completed" | "error" | "needs_input";
  featureTitle: string;
  featureId: number;
  projectId: number;
  routeType: "session";
}

/**
 * True when this window is currently showing the given feature's conversation.
 * Used to suppress notifications — and the sidebar unread dot — for the
 * feature the user is already looking at.
 *
 * Reads the hash route, not `window.location.pathname`: the app uses hash
 * history, so the route path lives in `window.location.hash` (`#/ws-session/…`)
 * and `pathname` is always `/` (which silently defeated this guard). Parsed
 * inline rather than via the router to avoid a router→routes→stores import
 * cycle through this module.
 */
export function isViewingFeature(featureId: number): boolean {
  const hashPath = window.location.hash.replace(/^#/, "").split("?")[0];
  return hashPath === `/ws-session/${wsSessionIdFromFeature(featureId)}`;
}

/** Colored status emoji prefixed to the title (`<emoji> | <feature title>`). */
function statusEmoji(status: NotifyOptions["status"]): string {
  switch (status) {
    case "completed":
      return "🟢";
    case "error":
      return "🔴";
    case "needs_input":
      return "🟠";
  }
}

/**
 * Start of the agent's latest reply, for the notification's second line.
 * Best-effort: on failure we fall back to the feature title, so a cosmetic
 * fetch error never blocks the (still user-visible) notification.
 */
async function fetchMessagePreview(featureId: number): Promise<string | null> {
  try {
    const { preview } = await getMessagePreview(featureId);
    return preview && preview.length > 0 ? preview : null;
  } catch (e) {
    console.warn("[notify] message preview fetch failed:", e);
    return null;
  }
}

/**
 * Send a native desktop notification for agent events (completion, error,
 * or waiting for user input), unless the user is already viewing that feature.
 * Title is `<emoji> | <feature title>`; the body is the start of the agent's
 * latest reply (falling back to the feature title). Clicking navigates to the
 * route and focuses the prompt.
 *
 * Fire-and-forget: the preview fetch is gated behind the same guards so we
 * never hit the network for a notification that won't show.
 */
export function notifyAgentDone(opts: NotifyOptions): void {
  if (!permissionCache) return;
  const mode = readNotificationMode();
  if (mode === "off") return;
  if (isViewingFeature(opts.featureId)) return;

  void (async () => {
    const preview = await fetchMessagePreview(opts.featureId);
    try {
      await desktopBridge.notify({
        title: `${statusEmoji(opts.status)} | ${opts.featureTitle}`,
        body: preview ?? opts.featureTitle,
        featureId: opts.featureId,
        projectId: opts.projectId,
        routeType: opts.routeType,
        mode,
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error("Couldn't send notification", { description: message });
    }
  })();
}

/**
 * Convenience wrapper: notify that an agent is waiting for user input.
 */
export function notifyAgentNeedsInput(opts: Omit<NotifyOptions, "status">): void {
  notifyAgentDone({ ...opts, status: "needs_input" });
}

interface NotificationClickPayload {
  feature_id: number;
  project_id: number;
  route_type: NotifyOptions["routeType"];
}

type NavigateFn = (opts: {
  to: string;
  params?: Record<string, string>;
  search?: Record<string, unknown>;
}) => Promise<void>;

/**
 * Listen for notification clicks and navigate to the relevant route.
 * Returns a cleanup function for use in useEffect.
 */
export function listenForNotificationClicks(
  navigate: NavigateFn,
  queryClient: QueryClient,
): () => void {
  return desktopBridge.onNotificationClicked((payload: NotificationClickPayload) => {
    openFromNotification(payload, navigate, queryClient);
  });
}

/**
 * In dev mode the main process can't deliver native notifications under
 * the Cadencr bundle id (the running binary is `com.github.Electron`),
 * so it forwards the payload here and we render an in-app Sonner toast
 * with an "Open" action that uses the same routing as a real click.
 * Returns a cleanup function for use in useEffect.
 */
export function listenForNotificationFallbacks(
  navigate: NavigateFn,
  queryClient: QueryClient,
): () => void {
  return desktopBridge.onNotificationFallback((payload: NotificationFallbackPayload) => {
    const click = payload.click;
    toast.message(payload.title, {
      description: payload.body,
      action: click
        ? {
            label: "Open",
            onClick: () => openFromNotification(click, navigate, queryClient),
          }
        : undefined,
    });
  });
}

/**
 * Open a session route from a Web Push notification click (PWA/remote). Reuses
 * the exact navigation the desktop notification path uses, so both shells land
 * on the same screen and focus the prompt.
 */
export function openSessionFromPush(
  navigate: NavigateFn,
  queryClient: QueryClient,
  featureId: number,
  projectId: number,
): void {
  openFromNotification(
    { feature_id: featureId, project_id: projectId, route_type: "session" },
    navigate,
    queryClient,
  );
}

function openFromNotification(
  payload: NotificationClickPayload,
  navigate: NavigateFn,
  queryClient: QueryClient,
): void {
  const { feature_id, project_id } = payload;
  const nav = navigate({
    to: "/ws-session/$sessionId",
    params: { sessionId: `ws-feature-${feature_id}` },
    search: {
      cwd: lookupProjectPath(queryClient, project_id),
      featureId: feature_id,
      projectId: project_id,
    },
  });
  void nav.then(() => {
    setTimeout(() => window.dispatchEvent(new CustomEvent("cadencr:focus-prompt")), 100);
  });
}

function lookupProjectPath(queryClient: QueryClient, projectId: number): string {
  for (const [, data] of queryClient.getQueriesData<Project[]>({
    queryKey: getListProjectsQueryKey(),
  })) {
    const project = data?.find((p) => p.id === projectId);
    if (project) return project.path;
  }
  return "";
}
