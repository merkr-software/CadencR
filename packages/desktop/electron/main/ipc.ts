import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  dialog,
  ipcMain,
  nativeTheme,
  shell,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import { getRendererRuntimeConfig } from "./runtime-config";
import { isMainRendererFrame, type RendererTarget } from "./renderer-trust";
import { rendererLoadTarget } from "./renderer-window-security";
import {
  notificationPermission,
  sendNotification,
  sendTestNotification,
  type NotifyOptions,
} from "./notifications";
import { sendToWindow } from "./safe-send";
import { parseAppCloseChoice, type AppCloseChoice } from "../../src/shared/app-close";
import { registerRendererDiagnosticsIpc } from "./renderer-diagnostics-ipc";
import { setLinkHoverContext, suppressNextNativeContextMenu } from "./context-menu";
import { assertOpenableLocalFile } from "./openable-local-file";
import {
  applyTrafficLights,
  parseTrafficLightsCenter,
  setTrafficLightsCenter,
} from "./traffic-lights";

const MAX_READ_FILE_BYTES = 16 * 1024 * 1024;
const MAX_FILE_HANDLES = 128;
const fileHandles = new Map<string, string>();

export interface IpcOptions {
  getMainWindow: () => BrowserWindow | null;
  confirmClose: (choice: AppCloseChoice) => void;
  requestQuit: () => void;
}

export function registerIpc({ getMainWindow, confirmClose, requestQuit }: IpcOptions): void {
  ipcMain.handle("runtime-config", (event) => {
    assertTrustedSender(event, getMainWindow);
    return getRendererRuntimeConfig();
  });
  ipcMain.handle("fs:register-file-paths", (event, rawPaths: unknown) => {
    assertTrustedSender(event, getMainWindow);
    return registerFilePaths(rawPaths);
  });
  ipcMain.handle("fs:read-file-base64", (event, fileHandle: unknown) => {
    assertTrustedSender(event, getMainWindow);
    return readFileBase64(fileHandle);
  });
  ipcMain.handle("shell:reveal", (event, filePath: unknown) => {
    assertTrustedSender(event, getMainWindow);
    return revealInFinder(filePath);
  });
  ipcMain.handle("shell:open-external", (event, url: unknown) => {
    assertTrustedSender(event, getMainWindow);
    return openExternal(url);
  });
  ipcMain.handle("shell:open-external-link", (event, url: unknown) => {
    assertTrustedSender(event, getMainWindow);
    return openExternalLink(url);
  });
  ipcMain.handle("links:set-hover-context", (event, context: unknown) => {
    assertTrustedSender(event, getMainWindow);
    setLinkHoverContext(context);
  });
  ipcMain.on("context-menu:suppress-next", (event) => {
    assertTrustedSender(event, getMainWindow);
    suppressNextNativeContextMenu(event.sender.id);
    event.returnValue = true;
  });
  ipcMain.handle("dialog:pick-directory", (event) => {
    assertTrustedSender(event, getMainWindow);
    return pickDirectory();
  });
  ipcMain.handle("dialog:pick-image-file", (event) => {
    assertTrustedSender(event, getMainWindow);
    return pickImageFile();
  });
  ipcMain.handle("dialog:save-file", (event, opts: unknown) => {
    assertTrustedSender(event, getMainWindow);
    return saveFileDialog(requireMainWindow(getMainWindow), parseSaveDialogOptions(opts));
  });
  ipcMain.handle("notify:permission", (event) => {
    assertTrustedSender(event, getMainWindow);
    return notificationPermission();
  });
  ipcMain.handle("notify:send", (event, opts: unknown) => {
    assertTrustedSender(event, getMainWindow);
    sendNotification(requireMainWindow(getMainWindow), parseNotifyOptions(opts));
  });
  ipcMain.handle("notify:test", (event) => {
    assertTrustedSender(event, getMainWindow);
    sendTestNotification(requireMainWindow(getMainWindow));
  });
  ipcMain.handle("app:confirm-close", (event, choice: unknown) => {
    assertTrustedSender(event, getMainWindow);
    confirmClose(parseAppCloseChoice(choice));
  });
  ipcMain.handle("app:request-quit", (event) => {
    assertTrustedSender(event, getMainWindow);
    requestQuit();
  });
  registerWindowControlIpc(getMainWindow);
  registerRendererDiagnosticsIpc(getMainWindow, (event) =>
    assertTrustedSender(event, getMainWindow),
  );
  ipcMain.handle("webview:set-zoom", (event, factor: unknown) => {
    assertTrustedSender(event, getMainWindow);
    const win = requireMainWindow(getMainWindow);
    win.webContents.setZoomFactor(parseZoomFactor(factor));
    applyTrafficLights(win);
  });
  ipcMain.handle("window:set-traffic-lights-center", (event, center: unknown) => {
    assertTrustedSender(event, getMainWindow);
    setTrafficLightsCenter(requireMainWindow(getMainWindow), parseTrafficLightsCenter(center));
  });
  ipcMain.handle("window:is-focused", (event) => {
    assertTrustedSender(event, getMainWindow);
    return requireMainWindow(getMainWindow).isFocused();
  });
  ipcMain.handle("theme:current", (event) => {
    assertTrustedSender(event, getMainWindow);
    return nativeTheme.shouldUseDarkColors ? "dark" : "light";
  });
}

/** App-owned window controls (the Linux frameless window has no native frame). */
function registerWindowControlIpc(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle("app:window-minimize", (event) => {
    assertTrustedSender(event, getMainWindow);
    requireMainWindow(getMainWindow).minimize();
  });
  ipcMain.handle("app:window-toggle-maximize", (event) => {
    assertTrustedSender(event, getMainWindow);
    const window = requireMainWindow(getMainWindow);
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  ipcMain.handle("app:window-close", (event) => {
    assertTrustedSender(event, getMainWindow);
    requireMainWindow(getMainWindow).close();
  });
}

export function registerThemeEvents(getMainWindow: () => BrowserWindow | null): void {
  nativeTheme.on("updated", () => {
    sendToWindow(
      getMainWindow(),
      "theme:updated",
      nativeTheme.shouldUseDarkColors ? "dark" : "light",
    );
  });
}

function requireMainWindow(getMainWindow: () => BrowserWindow | null): BrowserWindow {
  const mainWindow = getMainWindow();
  if (!mainWindow) throw new Error("Main window is not available.");
  return mainWindow;
}

export function clearRegisteredFilePaths(): void {
  fileHandles.clear();
}

export function assertTrustedSender(
  event: IpcMainEvent | IpcMainInvokeEvent,
  getMainWindow: () => BrowserWindow | null,
  target: RendererTarget = rendererLoadTarget(),
): void {
  const mainWindow = requireMainWindow(getMainWindow);
  if (event.sender.id !== mainWindow.webContents.id) {
    throw new Error("Rejected IPC call from an untrusted window.");
  }
  if (!isMainRendererFrame(event.senderFrame, mainWindow.webContents.mainFrame, target)) {
    throw new Error("Rejected IPC call from an untrusted renderer origin or frame.");
  }
}

export async function registerFilePaths(
  rawPaths: unknown,
): Promise<Array<{ handle: string; name: string }>> {
  if (!Array.isArray(rawPaths)) throw new Error("Expected a list of dropped file paths.");
  const registered: Array<{ handle: string; name: string }> = [];
  for (const rawPath of rawPaths) {
    if (typeof rawPath !== "string" || rawPath.length === 0) continue;
    const canonical = await canonicalFilePath(rawPath);
    const handle = randomUUID();
    rememberFileHandle(handle, canonical);
    registered.push({ handle, name: path.basename(canonical) });
  }
  return registered;
}

function rememberFileHandle(handle: string, canonical: string): void {
  while (fileHandles.size >= MAX_FILE_HANDLES) {
    const oldest = fileHandles.keys().next().value;
    if (oldest === undefined) break;
    fileHandles.delete(oldest);
  }
  fileHandles.set(handle, canonical);
}

export async function readFileBase64(rawHandle: unknown): Promise<string> {
  if (typeof rawHandle !== "string") throw new Error("Expected a file handle.");
  const canonical = fileHandles.get(rawHandle);
  if (!canonical) throw new Error("Unknown or expired file handle.");
  fileHandles.delete(rawHandle);
  const metadata = await fs.stat(canonical);
  if (metadata.size > MAX_READ_FILE_BYTES) {
    throw new Error(
      `Rejected: file is ${metadata.size} bytes, limit is ${MAX_READ_FILE_BYTES} bytes.`,
    );
  }
  const bytes = await fs.readFile(canonical);
  return bytes.toString("base64");
}

export async function canonicalFilePath(rawPath: string): Promise<string> {
  if (rawPath.split(/[\\/]+/).includes("..")) {
    throw new Error("Rejected: path contains `..`");
  }
  const canonical = await fs.realpath(rawPath);
  const metadata = await fs.stat(canonical);
  if (!metadata.isFile()) throw new Error("Rejected: path is not a file.");
  return canonical;
}

async function revealInFinder(rawPath: unknown): Promise<void> {
  if (typeof rawPath !== "string" || rawPath.length === 0) throw new Error("Expected a path.");
  const absolutePath = path.resolve(rawPath);
  await fs.access(absolutePath);
  shell.showItemInFolder(absolutePath);
}

export async function openExternal(rawUrl: unknown): Promise<void> {
  if (typeof rawUrl !== "string") throw new Error("Expected a URL.");
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "https:") {
    throw new Error("Only https:// URLs can be opened externally.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("URLs with embedded credentials cannot be opened externally.");
  }
  if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
    throw new Error("Loopback URLs cannot be opened externally.");
  }
  await shell.openExternal(parsed.toString());
}

/**
 * User-initiated "open in default browser" for a clicked link. Looser than
 * `openExternal` (which also backs auto navigation-interception): permits
 * `http:` and loopback so a dev-server URL can be opened in the system
 * browser on demand, and `file:` so agent-emitted links to local documents
 * open in their default app. Agents often emit a bare absolute path instead
 * of a `file:` URL; it is resolved against `file:///` because Markdown hrefs
 * arrive percent-encoded (`crm%20prototype.html`). Still rejects credentials
 * and any other scheme (`javascript:`, `data:`, ...).
 */
export async function openExternalLink(rawUrl: unknown): Promise<void> {
  if (typeof rawUrl !== "string") throw new Error("Expected a URL.");
  const parsed = rawUrl.startsWith("/") ? new URL(rawUrl, "file:///") : new URL(rawUrl);
  if (parsed.protocol === "file:") {
    // A file URL host becomes a UNC host on Windows (`\\server\share`), and
    // merely stat-ing that path dials out over SMB — local files only.
    if (parsed.hostname) {
      throw new Error("file:// links with a remote host cannot be opened.");
    }
    const canonical = await canonicalFilePath(fileURLToPath(parsed));
    assertOpenableLocalFile(canonical);
    const failure = await shell.openPath(canonical);
    if (failure) throw new Error(failure);
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http://, https:// and file:// links can be opened externally.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("URLs with embedded credentials cannot be opened externally.");
  }
  await shell.openExternal(parsed.toString());
}

async function pickDirectory(): Promise<string | null> {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

/**
 * Extensions offered when picking a project icon. Kept in lockstep with the
 * service's `icon_mime_for_path` allowlist — `.icns` is absent because
 * Chromium cannot decode it.
 */
const ICON_FILE_EXTENSIONS = ["svg", "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"];

async function pickImageFile(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: "Choose a project icon",
    properties: ["openFile"],
    filters: [{ name: "Images", extensions: ICON_FILE_EXTENSIONS }],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

interface SaveDialogOptions {
  defaultPath: string;
  title?: string;
}

export function parseSaveDialogOptions(rawOpts: unknown): SaveDialogOptions {
  if (!rawOpts || typeof rawOpts !== "object") {
    throw new Error("Expected save-dialog options.");
  }
  const opts = rawOpts as Record<string, unknown>;
  const defaultPath = opts.defaultPath;
  if (typeof defaultPath !== "string" || defaultPath.length === 0 || defaultPath.length > 4096) {
    throw new Error("Invalid save-dialog defaultPath.");
  }
  const title = opts.title;
  if (title !== undefined && (typeof title !== "string" || title.length > 120)) {
    throw new Error("Invalid save-dialog title.");
  }
  return { defaultPath, title: typeof title === "string" ? title : undefined };
}

async function saveFileDialog(
  parent: BrowserWindow,
  { defaultPath, title }: SaveDialogOptions,
): Promise<string | null> {
  const result = await dialog.showSaveDialog(parent, {
    defaultPath,
    title,
    properties: ["createDirectory", "showOverwriteConfirmation"],
  });
  return result.canceled ? null : (result.filePath ?? null);
}

export function parseZoomFactor(rawFactor: unknown): number {
  if (typeof rawFactor !== "number" || !Number.isFinite(rawFactor)) {
    throw new Error("Expected a numeric zoom factor.");
  }
  if (rawFactor < 0.5 || rawFactor > 2) throw new Error("Zoom factor must be between 0.5 and 2.");
  return rawFactor;
}

export function parseNotifyOptions(rawOpts: unknown): NotifyOptions {
  if (!rawOpts || typeof rawOpts !== "object") throw new Error("Expected notification options.");
  const opts = rawOpts as Record<string, unknown>;
  const routeType = opts.routeType;
  if (routeType !== "session") {
    throw new Error("Invalid notification route type.");
  }
  const mode = opts.mode;
  if (mode !== "native" && mode !== "in_app") {
    throw new Error("Invalid notification mode.");
  }
  return {
    title: boundedString(opts.title, "title", 120),
    body: boundedString(opts.body, "body", 500),
    featureId: positiveInteger(opts.featureId, "featureId"),
    projectId: positiveInteger(opts.projectId, "projectId"),
    routeType,
    mode,
  };
}

function boundedString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`Invalid notification ${name}.`);
  }
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid notification ${name}.`);
  }
  return value;
}
