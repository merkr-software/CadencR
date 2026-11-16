import type { BrowserWindow, OnBeforeSendHeadersListenerDetails, Session } from "electron";
import { getRuntimeConfig, type RuntimeConfig } from "./runtime-config";
import { isMainRendererFrame, type RendererFrame, type RendererTarget } from "./renderer-trust";
import { rendererLoadTarget } from "./renderer-window-security";

interface ServiceRequest {
  url: string;
  resourceType: string;
  webContentsId?: number;
  frame?: RendererFrame | null;
  requestHeaders: Record<string, string>;
}

interface ServiceRenderer {
  id: number;
  mainFrame: RendererFrame;
}

/** The browser owns bytes, uploads and sockets; only main can add the launch credential. */
export function serviceRequestHeaders(
  request: ServiceRequest,
  renderer: ServiceRenderer | null,
  target: RendererTarget,
  config: RuntimeConfig,
): Record<string, string> {
  const headers = { ...request.requestHeaders };
  // Redirects re-enter this hook: never forward an injected bearer to another origin.
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "x-cadencr-token") delete headers[key];
  }
  if (
    !renderer ||
    request.webContentsId !== renderer.id ||
    !isMainRendererFrame(request.frame, renderer.mainFrame, target) ||
    request.resourceType === "mainFrame" ||
    request.resourceType === "subFrame" ||
    Object.keys(headers).some((key) => key.toLowerCase() === "x-cadencr-plugin-token") ||
    !config.authToken ||
    !isServiceRequestUrl(request.url, config.baseUrl)
  ) {
    return headers;
  }
  headers["X-Cadencr-Token"] = config.authToken;
  return headers;
}

function isServiceRequestUrl(rawUrl: string, baseUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.username || url.password) return false;
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol === "wss:") url.protocol = "https:";
    return (
      url.origin === new URL(baseUrl).origin &&
      (url.pathname.startsWith("/api/") || url.pathname === "/ws" || url.pathname === "/health")
    );
  } catch {
    return false;
  }
}

export function installServiceTransport(
  session: Session,
  getMainWindow: () => BrowserWindow | null,
): void {
  // Default renderer session only. Browser profiles and plugin guests use separate sessions.
  session.webRequest.onBeforeSendHeaders(
    (details: OnBeforeSendHeadersListenerDetails, callback) => {
      const win = getMainWindow();
      if (!win || details.webContentsId !== win.webContents.id) {
        callback({});
        return;
      }
      callback({
        requestHeaders: serviceRequestHeaders(
          details,
          win.webContents,
          rendererLoadTarget(),
          getRuntimeConfig(),
        ),
      });
    },
  );
}
