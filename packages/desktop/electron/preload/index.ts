import { contextBridge, ipcRenderer, webUtils } from "electron";

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
  setZoom: (factor: number): Promise<void> => ipcRenderer.invoke("webview:set-zoom", factor),
  currentTheme: (): Promise<DesktopTheme> => ipcRenderer.invoke("theme:current"),
  onThemeChange: (cb: (appearance: DesktopTheme) => void): (() => void) =>
    onIpc("theme:updated", cb),
  setBusy: (busy: boolean): Promise<void> => ipcRenderer.invoke("power:set-busy", busy),
  onPowerSuspend: (cb: () => void): (() => void) => onIpc("power:suspend", cb),
  onPowerResume: (cb: () => void): (() => void) => onIpc("power:resume", cb),
  checkForUpdates: (): Promise<void> => ipcRenderer.invoke("app:check-for-updates"),
  installUpdate: (): Promise<void> => ipcRenderer.invoke("app:install-update"),
  fetchChangelog: (version: string): Promise<string | null> =>
    ipcRenderer.invoke("app:fetch-changelog", version),
  onUpdateEvent,
});
