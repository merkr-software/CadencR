import {
  clipboard,
  Menu,
  type BrowserWindow,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";

/**
 * Install the right-click context menu for a window.
 *
 * Two reasons this exists:
 *
 *   1. UX: provide the standard misspelling / link / image / cut-copy-paste
 *      entries Chromium offers by default but which Electron leaves to the
 *      app to render.
 *   2. Crash workaround: on macOS 26 (Tahoe) + Electron 42, right-clicking
 *      a `-webkit-app-region: drag` element segfaults the browser process
 *      inside `-[NSApplication sendEvent:]` (see `src/index.css` for
 *      details). Suppressing the default and immediately popping up our
 *      own menu via `Menu.popup({ window })` consumes the AppKit event
 *      before the native window-controls menu can run, which stops the
 *      crash. This is the same pattern t3code uses on Electron 40, ported
 *      forward to our Electron 42 setup.
 */
/**
 * The link the pointer is currently over, pushed from the renderer (terminal
 * web-links or chat anchors) via `links:set-hover-context`. The native menu
 * reads it to offer feature-scoped open choices, since xterm links aren't real
 * DOM anchors and so never populate `params.linkURL`. Shape mirrors the
 * renderer's `LinkHoverContext`.
 */
interface LinkHoverContext {
  url: string;
  scopeId: number | null;
  cookieMode: string;
}

let currentLinkContext: LinkHoverContext | null = null;

/** Validate and store the renderer-pushed hover context (or clear it). */
export function setLinkHoverContext(raw: unknown): void {
  if (raw == null || typeof raw !== "object") {
    currentLinkContext = null;
    return;
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.url !== "string" || obj.url.length === 0) {
    currentLinkContext = null;
    return;
  }
  currentLinkContext = {
    url: obj.url,
    scopeId: typeof obj.scopeId === "number" ? obj.scopeId : null,
    cookieMode: typeof obj.cookieMode === "string" ? obj.cookieMode : "normal",
  };
}

/** Append the Cadencr / default-browser / copy items for `link` to `items`. */
function pushLinkItems(
  items: MenuItemConstructorOptions[],
  webContents: WebContents,
  link: LinkHoverContext,
): void {
  if (link.scopeId != null) {
    items.push({
      label: "Open Link in Cadencr Browser",
      click: () =>
        webContents.send("links:open-from-menu", {
          url: link.url,
          target: "cadencr",
          scopeId: link.scopeId,
          cookieMode: link.cookieMode,
        }),
    });
  }
  items.push(
    {
      label: "Open Link in Default Browser",
      click: () =>
        webContents.send("links:open-from-menu", {
          url: link.url,
          target: "default",
          scopeId: link.scopeId,
          cookieMode: link.cookieMode,
        }),
    },
    { label: "Copy Link", click: () => clipboard.writeText(link.url) },
    { type: "separator" },
  );
}

/** Reconcile the renderer hover context with Chromium's own `linkURL`. */
function resolveLinkContext(paramsLinkUrl: string): LinkHoverContext | null {
  if (currentLinkContext && currentLinkContext.url === paramsLinkUrl) return currentLinkContext;
  if (currentLinkContext && paramsLinkUrl.length === 0) return currentLinkContext;
  if (paramsLinkUrl.length > 0) {
    return { url: paramsLinkUrl, scopeId: null, cookieMode: "normal" };
  }
  return null;
}

export function installContextMenu(window: BrowserWindow, webContents: WebContents): void {
  webContents.on("context-menu", (event, params) => {
    event.preventDefault();

    const items: MenuItemConstructorOptions[] = [];

    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        items.push({
          label: suggestion,
          click: () => webContents.replaceMisspelling(suggestion),
        });
      }
      if (params.dictionarySuggestions.length === 0) {
        items.push({ label: "No suggestions", enabled: false });
      }
      items.push({ type: "separator" });
    }

    const link = resolveLinkContext(params.linkURL);
    if (link) pushLinkItems(items, webContents, link);

    if (params.mediaType === "image") {
      items.push(
        { label: "Copy Image", click: () => webContents.copyImageAt(params.x, params.y) },
        { type: "separator" },
      );
    }

    items.push(
      { role: "cut", enabled: params.editFlags.canCut },
      { role: "copy", enabled: params.editFlags.canCopy },
      { role: "paste", enabled: params.editFlags.canPaste },
      { role: "selectAll", enabled: params.editFlags.canSelectAll },
    );

    Menu.buildFromTemplate(items).popup({ window });
  });
}
