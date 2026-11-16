import { ipcRenderer, webFrame } from "electron";

/**
 * Preload of a custom-tab guest (docs/CUSTOM_TABS.md §5). Deliberately exposes
 * NOTHING to the page — no `contextBridge` API. It only:
 *
 * 1. injects the host theme CSS before first paint (a synchronous query, so the
 *    stylesheet is in place before the document's own scripts run) and swaps
 *    it when the theme changes;
 * 2. forwards the guest's end of the broker `MessageChannel` to the page with
 *    `window.postMessage`. The page accepts it with
 *    `event.source === window && event.data?.type === "cadencr-tab:port"` and
 *    takes `event.ports[0]`; it arrives after the `load` event, once per load.
 *
 * A sandboxed preload can't load a shared chunk, so nothing here may import a
 * local module — the channel names are literals mirrored in
 * `electron/main/plugin-tabs/plugin-tab-ids.ts` (`cadencr-tab:theme-css`,
 * `cadencr-tab:theme`, `cadencr-tab:port`).
 */

let themeKey: string | null = null;

function applyTheme(css: unknown): void {
  if (themeKey !== null) webFrame.removeInsertedCSS(themeKey);
  themeKey = typeof css === "string" && css.length > 0 ? webFrame.insertCSS(css) : null;
}

applyTheme(ipcRenderer.sendSync("cadencr-tab:theme-css"));

ipcRenderer.on("cadencr-tab:theme", (_event, css: unknown) => applyTheme(css));

ipcRenderer.on("cadencr-tab:port", (event) => {
  window.postMessage({ type: "cadencr-tab:port" }, "*", event.ports);
});
