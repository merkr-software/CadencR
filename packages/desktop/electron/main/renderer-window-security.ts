import path from "node:path";
import { app, session, shell, type WebContents } from "electron";
import { rendererCsp, resolveRendererCspDevelopment } from "./csp";
import { approvedExternalUrl, isAllowedNavigationUrl, isLoopbackDevUrl } from "./navigation";
import { packagedRendererDir } from "./sidecar";
import { keepsOwnCsp } from "./visual-frame-csp";

export function installCsp(): void {
  const development = resolveRendererCspDevelopment(process.env);
  const csp = rendererCsp(app.isPackaged, development);
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (keepsOwnCsp(details)) {
      callback({});
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
      },
    });
  });
}

export function rendererLoadTarget():
  | { kind: "url"; value: string }
  | { kind: "file"; value: string } {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && rendererUrl) {
    if (!isLoopbackDevUrl(rendererUrl)) {
      throw new Error(`Rejected untrusted ELECTRON_RENDERER_URL: ${rendererUrl}`);
    }
    return { kind: "url", value: rendererUrl };
  }
  const rendererIndex = app.isPackaged
    ? path.join(packagedRendererDir(), "index.html")
    : path.join(__dirname, "../renderer/index.html");
  return { kind: "file", value: rendererIndex };
}

export function secureWebContents(webContents: WebContents): void {
  webContents.setWindowOpenHandler(({ url }) => {
    void openApprovedExternalUrl(url);
    return { action: "deny" };
  });
  webContents.on("will-navigate", (event, url) => {
    if (isAllowedNavigationUrl(url, app.isPackaged)) return;
    event.preventDefault();
    void openApprovedExternalUrl(url);
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(isAllowedPermission(permission));
  });
  // queryLocalFonts() triggers a synchronous permission *check* (not a request)
  // in Chromium, so both handlers must allow `local-fonts`. Trusted local app.
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) =>
    isAllowedPermission(permission),
  );
}

/**
 * `local-fonts` is a real Chromium permission (backs the Local Font Access
 * API, `window.queryLocalFonts()`) but Electron's bundled type defs don't
 * list it yet, hence the widen-then-compare instead of a direct literal
 * match against `Electron.Permission`.
 */
function isAllowedPermission(permission: string): boolean {
  return (
    permission === "clipboard-sanitized-write" ||
    permission === "clipboard-read" ||
    permission === "local-fonts"
  );
}

async function openApprovedExternalUrl(rawUrl: string): Promise<void> {
  const url = approvedExternalUrl(rawUrl);
  if (url) await shell.openExternal(url);
}
