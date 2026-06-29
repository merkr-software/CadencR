import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";
import type {
  BrowserBounds,
  BrowserCommentBadgeClick,
  BrowserProfileMetadata,
  BrowserShortcut,
  BrowserStateSnapshot,
  BrowserTabMetadata,
} from "../main/browser-types";

type RouteType = "workflow" | "session";
type DesktopTheme = "light" | "dark";

interface RuntimeConfig {
  baseUrl: string;
  authToken: string | null;
}

interface NotificationClickPayload {
  feature_id: number;
  project_id: number;
  route_type: RouteType;
}

interface NotificationFallbackPayload {
  title: string;
  body: string;
  click: NotificationClickPayload | null;
}

type NotifyMode = "native" | "in_app";

interface NotifyOptions {
  title: string;
  body: string;
  featureId: number;
  projectId: number;
  routeType: RouteType;
  mode: NotifyMode;
}

interface RendererErrorReportPayload {
  source: "error" | "unhandledrejection" | "react-boundary";
  message: string;
  stack?: string | null;
  componentStack?: string | null;
  url?: string | null;
  line?: number | null;
  column?: number | null;
}

interface FileDropItem {
  handle: string;
  name: string;
}

interface FileDropPayload {
  type: "enter" | "leave" | "drop" | "error";
  files: FileDropItem[];
  targetPromptId?: string;
  message?: string;
}

type UpdateEvent =
  | { kind: "checking" }
  | { kind: "available"; version: string }
  | { kind: "changelog"; version: string; markdown: string | null }
  | { kind: "not-available"; version: string }
  | { kind: "error"; message: string }
  | { kind: "download-progress"; percent: number; bytesPerSecond: number }
  | { kind: "downloaded"; version: string };

function onUpdateEvent(cb: (event: UpdateEvent) => void): () => void {
  const unsubs = [
    onIpc<void>("update:checking", () => cb({ kind: "checking" })),
    onIpc<{ version: string }>("update:available", (p) =>
      cb({ kind: "available", version: p.version }),
    ),
    onIpc<{ version: string; markdown: string | null }>("update:changelog", (p) =>
      cb({ kind: "changelog", version: p.version, markdown: p.markdown }),
    ),
    onIpc<{ version: string }>("update:not-available", (p) =>
      cb({ kind: "not-available", version: p.version }),
    ),
    onIpc<{ message: string }>("update:error", (p) => cb({ kind: "error", message: p.message })),
    onIpc<{ percent: number; bytesPerSecond: number }>("update:download-progress", (p) =>
      cb({ kind: "download-progress", percent: p.percent, bytesPerSecond: p.bytesPerSecond }),
    ),
    onIpc<{ version: string }>("update:downloaded", (p) =>
      cb({ kind: "downloaded", version: p.version }),
    ),
  ];
  return () => {
    for (const off of unsubs) off();
  };
}

function onIpc<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

function resolvePromptIdFromEvent(event: DragEvent): string | undefined {
  // composedPath() walks through shadow DOM and gives us the actual elements
  // under the cursor. Prefer that; fall back to climbing from `event.target`
  // when composedPath is empty (jsdom, older WebView).
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  for (const node of path) {
    if (node instanceof Element && node.hasAttribute("data-agent-prompt-id")) {
      return node.getAttribute("data-agent-prompt-id") ?? undefined;
    }
  }
  const fromTarget =
    event.target instanceof Element
      ? event.target
      : event.target instanceof Node
        ? event.target.parentElement
        : null;
  return (
    fromTarget?.closest("[data-agent-prompt-id]")?.getAttribute("data-agent-prompt-id") ?? undefined
  );
}

function onFileDrop(cb: (payload: FileDropPayload) => void): () => void {
  let dragDepth = 0;
  const onDragOver = (event: DragEvent): void => event.preventDefault();
  const onDragEnter = (event: DragEvent): void => {
    event.preventDefault();
    dragDepth += 1;
    if (dragDepth === 1) cb({ type: "enter", files: [] });
  };
  const onDragLeave = (event: DragEvent): void => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) cb({ type: "leave", files: [] });
  };
  const onDrop = (event: DragEvent): void => {
    event.preventDefault();
    dragDepth = 0;
    // `event.target` is occasionally a non-Element Node (e.g. a Text node when
    // the drop lands directly on text inside the prompt editor). Walk the
    // composedPath first so shadow-DOM hosts are handled, then fall back to
    // the parent element of a Node target so we don't lose valid prompt drops.
    const targetPromptId = resolvePromptIdFromEvent(event);
    const files = Array.from(event.dataTransfer?.files ?? []);
    const paths = files.map((file) => webUtils.getPathForFile(file)).filter(Boolean);
    void ipcRenderer
      .invoke("fs:register-file-paths", paths)
      .then((registered: FileDropItem[]) => {
        cb({ type: "drop", files: registered, targetPromptId });
      })
      .catch((error: unknown) => {
        cb({
          type: "error",
          files: [],
          message: error instanceof Error ? error.message : String(error),
        });
      });
  };
  document.addEventListener("dragover", onDragOver);
  document.addEventListener("dragenter", onDragEnter);
  document.addEventListener("dragleave", onDragLeave);
  document.addEventListener("drop", onDrop);
  return () => {
    document.removeEventListener("dragover", onDragOver);
    document.removeEventListener("dragenter", onDragEnter);
    document.removeEventListener("dragleave", onDragLeave);
    document.removeEventListener("drop", onDrop);
  };
}

contextBridge.exposeInMainWorld("cadencr", {
  isElectron: true,
  runtimeConfig: (): Promise<RuntimeConfig> => ipcRenderer.invoke("runtime-config"),
  readFileBase64: (handle: string): Promise<string> =>
    ipcRenderer.invoke("fs:read-file-base64", handle),
  onFileDrop,
  revealInFinder: (path: string): Promise<void> => ipcRenderer.invoke("shell:reveal", path),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("shell:open-external", url),
  openExternalLink: (url: string): Promise<void> =>
    ipcRenderer.invoke("shell:open-external-link", url),
  setLinkHoverContext: (context: unknown): Promise<void> =>
    ipcRenderer.invoke("links:set-hover-context", context),
  onOpenLinkFromMenu: (cb: (payload: unknown) => void): (() => void) =>
    onIpc("links:open-from-menu", cb),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke("dialog:pick-directory"),
  showSaveDialog: (opts: { defaultPath: string; title?: string }): Promise<string | null> =>
    ipcRenderer.invoke("dialog:save-file", opts),
  notifyPermission: (): Promise<boolean> => ipcRenderer.invoke("notify:permission"),
  notify: (opts: NotifyOptions): Promise<void> => ipcRenderer.invoke("notify:send", opts),
  notifyTest: (): Promise<void> => ipcRenderer.invoke("notify:test"),
  onNotificationClicked: (cb: (payload: NotificationClickPayload) => void): (() => void) =>
    onIpc("notification-clicked", cb),
  onNotificationFailed: (cb: (payload: { reason: string }) => void): (() => void) =>
    onIpc("notification-failed", cb),
  onNotificationFallback: (cb: (payload: NotificationFallbackPayload) => void): (() => void) =>
    onIpc("notification-fallback", cb),
  onCloseRequested: (cb: () => void): (() => void) => onIpc("app:close-requested", cb),
  confirmClose: (): Promise<void> => ipcRenderer.invoke("app:confirm-close"),
  requestQuit: (): Promise<void> => ipcRenderer.invoke("app:request-quit"),
  reportRendererError: (payload: RendererErrorReportPayload): Promise<void> =>
    ipcRenderer.invoke("app:renderer-error", payload),
  setZoom: (factor: number): Promise<void> => ipcRenderer.invoke("webview:set-zoom", factor),
  currentTheme: (): Promise<DesktopTheme> => ipcRenderer.invoke("theme:current"),
  onThemeChange: (cb: (appearance: DesktopTheme) => void): (() => void) =>
    onIpc("theme:updated", cb),
  setBusy: (busy: boolean): Promise<void> => ipcRenderer.invoke("power:set-busy", busy),
  setRemoteHostAwake: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke("power:set-remote-host", enabled),
  onPowerSuspend: (cb: () => void): (() => void) => onIpc("power:suspend", cb),
  onPowerResume: (cb: () => void): (() => void) => onIpc("power:resume", cb),

  createBrowserTab: (
    url?: string,
    profileId?: string,
    scopeId?: number | null,
  ): Promise<BrowserTabMetadata> =>
    ipcRenderer.invoke("browser:create-tab", url, profileId, scopeId),
  listBrowserTabs: (scopeId?: number | null): Promise<BrowserStateSnapshot> =>
    ipcRenderer.invoke("browser:list-tabs", scopeId),
  listBrowserTabCountsByScope: (): Promise<Record<number, number>> =>
    ipcRenderer.invoke("browser:tab-counts-by-scope"),
  navigateBrowserTab: (tabId: string, url: string): Promise<BrowserTabMetadata> =>
    ipcRenderer.invoke("browser:navigate", tabId, url),
  activateBrowserTab: (tabId: string): Promise<BrowserTabMetadata> =>
    ipcRenderer.invoke("browser:activate-tab", tabId),
  closeBrowserTab: (tabId: string): Promise<BrowserStateSnapshot> =>
    ipcRenderer.invoke("browser:close-tab", tabId),
  closeBrowserTabsForScope: (scopeId: number): Promise<BrowserStateSnapshot> =>
    ipcRenderer.invoke("browser:close-tabs-for-scope", scopeId),
  setBrowserBounds: (
    bounds: BrowserBounds,
    scopeId?: number | null,
    // The bounds are zoomed CSS px from getBoundingClientRect; read the zoom
    // factor here in the renderer so it matches the layout we just measured.
    // Reading it in the main process instead races with zoom propagation and
    // shifts the native view toward the window origin until the next zoom change.
  ): Promise<BrowserStateSnapshot> =>
    ipcRenderer.invoke("browser:set-bounds", bounds, scopeId, webFrame.getZoomFactor()),
  setBrowserSuppressed: (value: boolean): Promise<void> =>
    ipcRenderer.invoke("browser:set-suppressed", value),
  listBrowserProfiles: (): Promise<BrowserProfileMetadata[]> =>
    ipcRenderer.invoke("browser:list-profiles"),
  clearBrowserStorage: (profileId: string): Promise<void> =>
    ipcRenderer.invoke("browser:clear-storage", profileId),
  createBrowserProfile: (profileId: string): Promise<BrowserProfileMetadata> =>
    ipcRenderer.invoke("browser:create-profile", profileId),
  duplicateBrowserProfile: (sourceId: string, newId: string): Promise<BrowserProfileMetadata> =>
    ipcRenderer.invoke("browser:duplicate-profile", sourceId, newId),
  deleteBrowserProfile: (profileId: string): Promise<void> =>
    ipcRenderer.invoke("browser:delete-profile", profileId),
  browserBack: (tabId: string): Promise<void> => ipcRenderer.invoke("browser:back", tabId),
  browserForward: (tabId: string): Promise<void> => ipcRenderer.invoke("browser:forward", tabId),
  browserReload: (tabId: string): Promise<void> => ipcRenderer.invoke("browser:reload", tabId),
  browserStop: (tabId: string): Promise<void> => ipcRenderer.invoke("browser:stop", tabId),
  browserZoomIn: (tabId: string): Promise<void> => ipcRenderer.invoke("browser:zoom-in", tabId),
  browserZoomOut: (tabId: string): Promise<void> => ipcRenderer.invoke("browser:zoom-out", tabId),
  toggleBrowserDevTools: (tabId: string): Promise<BrowserTabMetadata> =>
    ipcRenderer.invoke("browser:toggle-devtools", tabId),
  getBrowserConsole: (): Promise<unknown[]> => ipcRenderer.invoke("browser:get-console"),
  getBrowserNetwork: (): Promise<unknown[]> => ipcRenderer.invoke("browser:get-network"),
  getBrowserSnapshot: (tabId: string): Promise<unknown> =>
    ipcRenderer.invoke("browser:get-snapshot", tabId),
  getBrowserScreenshot: (tabId: string): Promise<string> =>
    ipcRenderer.invoke("browser:screenshot", tabId),
  browserClick: (tabId: string, x: number, y: number): Promise<void> =>
    ipcRenderer.invoke("browser:click", tabId, x, y),
  browserType: (tabId: string, text: string): Promise<void> =>
    ipcRenderer.invoke("browser:type", tabId, text),
  browserKeypress: (tabId: string, keyCode: string): Promise<void> =>
    ipcRenderer.invoke("browser:keypress", tabId, keyCode),
  selectBrowserElementContext: (tabId: string, anchorId: string): Promise<unknown> =>
    ipcRenderer.invoke("browser:select-element-context", tabId, anchorId),
  removeBrowserCommentBadge: (tabId: string, anchorId: string): Promise<void> =>
    ipcRenderer.invoke("browser:remove-comment-badge", tabId, anchorId),
  clearBrowserCommentBadges: (tabId: string): Promise<void> =>
    ipcRenderer.invoke("browser:clear-comment-badges", tabId),
  onBrowserState: (cb: (state: BrowserStateSnapshot) => void): (() => void) =>
    onIpc("browser:state", cb),
  onBrowserTabCounts: (cb: (counts: Record<number, number>) => void): (() => void) =>
    onIpc("browser:tab-counts", cb),
  onBrowserShortcut: (cb: (shortcut: BrowserShortcut) => void): (() => void) =>
    onIpc("browser:shortcut", cb),
  onBrowserCommentBadgeClick: (cb: (event: BrowserCommentBadgeClick) => void): (() => void) =>
    onIpc("browser:comment-badge-click", cb),
  checkForUpdates: (): Promise<void> => ipcRenderer.invoke("app:check-for-updates"),
  installUpdate: (): Promise<void> => ipcRenderer.invoke("app:install-update"),
  fetchChangelog: (version: string): Promise<string | null> =>
    ipcRenderer.invoke("app:fetch-changelog", version),
  onUpdateEvent,
});
