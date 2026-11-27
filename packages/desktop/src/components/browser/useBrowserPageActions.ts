import { translateUi } from "@/lib/i18n/ui";
import { useCallback, useMemo } from "react";

import { desktopBridge, type BrowserTabMetadata } from "@/lib/desktop-bridge";

export interface BrowserPageActions {
  back: () => void;
  forward: () => void;
  reload: () => void;
  stop: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;
  devTools: () => void;
  openExternal: () => void;
}

export function useBrowserPageActions(
  runForActive: (action: (tab: BrowserTabMetadata) => Promise<void>) => Promise<void>,
): BrowserPageActions {
  const bridgeAction = useCallback(
    (action: (tabId: string) => Promise<void>): void => void runForActive((tab) => action(tab.id)),
    [runForActive],
  );
  const back = useCallback(
    () => bridgeAction((tabId) => desktopBridge.browserBack(tabId)),
    [bridgeAction],
  );
  const forward = useCallback(
    () => bridgeAction((tabId) => desktopBridge.browserForward(tabId)),
    [bridgeAction],
  );
  const reload = useCallback(
    () => bridgeAction((tabId) => desktopBridge.browserReload(tabId)),
    [bridgeAction],
  );
  const stop = useCallback(
    () => bridgeAction((tabId) => desktopBridge.browserStop(tabId)),
    [bridgeAction],
  );
  const zoomIn = useCallback(
    () => bridgeAction((tabId) => desktopBridge.browserZoomIn(tabId)),
    [bridgeAction],
  );
  const zoomOut = useCallback(
    () => bridgeAction((tabId) => desktopBridge.browserZoomOut(tabId)),
    [bridgeAction],
  );
  const zoomReset = useCallback(
    () => bridgeAction((tabId) => desktopBridge.browserZoomReset(tabId)),
    [bridgeAction],
  );
  const devTools = useCallback(
    (): void =>
      void runForActive((tab) => desktopBridge.toggleBrowserDevTools(tab.id).then(() => undefined)),
    [runForActive],
  );
  const openExternal = useCallback(
    (): void =>
      void runForActive(async (tab) => {
        assertExternalFallbackUrl(tab.url);
        await desktopBridge.openExternalLink(tab.url);
      }),
    [runForActive],
  );
  return useMemo(
    () => ({ back, forward, reload, stop, zoomIn, zoomOut, zoomReset, devTools, openExternal }),
    [back, devTools, forward, openExternal, reload, stop, zoomIn, zoomOut, zoomReset],
  );
}

function assertExternalFallbackUrl(rawUrl: string): void {
  const parsed = new URL(rawUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (
    parsed.username ||
    parsed.password ||
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))
  ) {
    throw new Error(
      translateUi(
        "workspace.tools.useBrowserPageActions.onlyHttpsOrLocalHttpPagesCan",
        "Only HTTPS or local HTTP pages can be opened in the default browser.",
      ),
    );
  }
}
