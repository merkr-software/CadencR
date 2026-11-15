import { isHttpBrowserUrl } from "../../src/shared/browser-url";
import { faviconDataUrl } from "./browser-favicon";
import { rasterizeBrowserFaviconSvg } from "./browser-favicon-rasterizer";
import { updateTabMetadata } from "./browser-manager-utils";
import type { ManagedTab, TabEventHost } from "./browser-tab-events";

const FAVICON_WORLD_ID = 1003;
const MAX_FAVICON_CANDIDATES = 8;
const MAX_FAVICON_URL_LENGTH = 4096;

/** Own loading state, declared-icon events, and reload recovery for one guest tab. */
export function installBrowserFaviconEvents(tab: ManagedTab, host: TabEventHost): void {
  const wc = tab.webContents;
  let generation = 0;
  let needsIconRecovery = true;
  let abort: AbortController | null = null;
  const load = (candidates: string[] | null): void => {
    abort?.abort();
    const controller = new AbortController();
    abort = controller;
    const request = ++generation;
    const pageUrl = wc.getURL();
    const isCurrent = (): boolean =>
      request === generation && host.isTabAlive() && !wc.isDestroyed() && wc.getURL() === pageUrl;
    let task: Promise<void>;
    task = loadCurrentFavicon(tab, candidates, pageUrl, controller.signal, isCurrent)
      .then((dataUrl) => {
        if (dataUrl && isCurrent()) updateTabMetadata(tab, { faviconUrl: dataUrl }, host);
      })
      .catch((error: unknown) => {
        if (!isCurrent()) return;
        host.setTabError(
          `Could not load page icon: ${error instanceof Error ? error.message : String(error)}`,
        );
        host.emitState();
      })
      .finally(() => {
        tab.pendingSessionTasks.delete(task);
        if (abort === controller) abort = null;
      });
    tab.pendingSessionTasks.add(task);
  };

  wc.once("destroyed", () => abort?.abort());
  wc.on("did-start-loading", () => {
    abort?.abort();
    abort = null;
    generation += 1;
    needsIconRecovery = true;
    host.invalidateFind();
    host.setTabError(null);
    updateTabMetadata(tab, { loading: true, faviconUrl: undefined }, host);
  });
  wc.on("did-stop-loading", () => {
    updateTabMetadata(tab, { loading: false }, host);
    if (needsIconRecovery) load(null);
  });
  wc.on("did-fail-load", (_event, _code, _description, _url, isMainFrame) => {
    if (!isMainFrame) return;
    needsIconRecovery = false;
    generation += 1;
    abort?.abort();
    abort = null;
  });
  wc.on("page-favicon-updated", (_event, favicons) => {
    needsIconRecovery = false;
    load(favicons);
  });
}

async function loadCurrentFavicon(
  tab: ManagedTab,
  candidates: string[] | null,
  pageUrl: string,
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<string | null> {
  const urls = candidates ?? (await recoverFaviconCandidates(tab, pageUrl));
  if (signal.aborted || !isCurrent()) return null;
  const boundedUrls = urls.slice(0, MAX_FAVICON_CANDIDATES).filter(isSafeFaviconUrl);
  for (const candidate of new Set(boundedUrls)) {
    const dataUrl = await faviconDataUrl(
      tab.webContents.session,
      candidate,
      signal,
      rasterizeBrowserFaviconSvg,
    );
    if (dataUrl || signal.aborted) return dataUrl;
  }
  return null;
}

async function recoverFaviconCandidates(tab: ManagedTab, pageUrl: string): Promise<string[]> {
  if (!isHttpBrowserUrl(pageUrl)) return [];
  const result: unknown = await tab.webContents.executeJavaScriptInIsolatedWorld(FAVICON_WORLD_ID, [
    {
      code: `Array.prototype.slice.call(document.querySelectorAll('link[rel~="icon"]'), 0, ${MAX_FAVICON_CANDIDATES})
        .map((link) => link.href).filter((url) => url.length <= ${MAX_FAVICON_URL_LENGTH})`,
    },
  ]);
  const declared = Array.isArray(result)
    ? result.slice(0, MAX_FAVICON_CANDIDATES).filter(isSafeFaviconUrl)
    : [];
  const fallback = new URL("/favicon.ico", new URL(pageUrl).origin).toString();
  return declared.includes(fallback)
    ? declared
    : [...declared.slice(0, MAX_FAVICON_CANDIDATES - 1), fallback];
}

function isSafeFaviconUrl(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= MAX_FAVICON_URL_LENGTH && isHttpBrowserUrl(value)
  );
}
