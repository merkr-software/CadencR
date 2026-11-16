import { randomUUID } from "node:crypto";
import type { Session } from "electron";
import { redactBrowserHeaders } from "./browser-policy";
import { BrowserNetworkHeadersCache, networkFailureReason } from "./browser-network-headers";
import type { BrowserNetworkEntry } from "./browser-types";
import { isCadencrBrowserUrl } from "./browser-self-origin-policy";
import { isBrowserOriginPolicyReady } from "./runtime-config";

type NetworkDetails = Electron.OnCompletedListenerDetails | Electron.OnErrorOccurredListenerDetails;

// Instruments Electron sessions once each and turns completed/failed requests
// into bounded, header-redacted entries. The owning manager maps the
// webContents id back to a tab and stores the entry.
export class BrowserNetworkCollector {
  private readonly instrumented = new WeakSet<Session>();
  private readonly headers = new BrowserNetworkHeadersCache();

  constructor(
    private readonly onEntry: (
      webContentsId: number,
      entry: Omit<BrowserNetworkEntry, "tabId">,
    ) => void,
    private readonly isAutomationRequest: (webContentsId: number | undefined) => boolean = () =>
      true,
  ) {}

  ensure(session: Session): void {
    if (this.instrumented.has(session)) return;
    this.instrumented.add(session);
    // Apply to subframes, fetches and redirects as well as top-level loads.
    // Human-only tabs retain ordinary browsing; shared/agent tabs cannot reach
    // the privileged app or API, including via fetches from an approved site.
    session.webRequest.onBeforeRequest((details, callback) => {
      callback({
        cancel:
          this.isAutomationRequest(details.webContentsId) &&
          (!isBrowserOriginPolicyReady() || isCadencrBrowserUrl(details.url)),
      });
    });
    session.webRequest.onBeforeSendHeaders((details, callback) => {
      this.headers.remember(details.id, details.requestHeaders);
      callback({ requestHeaders: details.requestHeaders });
    });
    session.webRequest.onCompleted((details) => this.record(details));
    session.webRequest.onErrorOccurred((details) => this.record(details));
  }

  private record(details: NetworkDetails): void {
    // Taken first: every finished request releases its headers, including the
    // ones no tab owns (service workers, the session's own requests).
    const requestHeaders = this.headers.take(details.id);
    const webContentsId = details.webContentsId;
    if (webContentsId === undefined) return;
    const response = "statusCode" in details ? details : null;
    this.onEntry(webContentsId, {
      id: randomUUID(),
      method: details.method,
      url: details.url,
      status: response?.statusCode,
      requestHeaders,
      responseHeaders: redactBrowserHeaders(response?.responseHeaders ?? {}),
      resourceType: details.resourceType,
      timestamp: new Date().toISOString(),
      failureReason: networkFailureReason(details),
    });
  }
}
