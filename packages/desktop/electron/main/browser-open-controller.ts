import type { BrowserAutomationAuthority } from "./browser-automation-authority";
import type { BrowserInspectionController } from "./browser-inspection-controller";
import { originOf } from "./browser-manager-utils";
import type { BrowserOpenUrlOptions, BrowserTabMetadata } from "./browser-types";
import type { ManagedTab } from "./browser-tab-events";
import { assertBrowserAgentUrl } from "./browser-policy";

interface BrowserOpenHost {
  activeTabId(scopeId: number | null): string | null;
  navigate(tabId: string, url: string): BrowserTabMetadata;
  createAgentTab(url: string, scopeId: number | null): BrowserTabMetadata;
  requireTab(tabId: string): ManagedTab;
}

/** Provider-neutral agent URL opening with per-scope authorization checks. */
export class BrowserOpenController {
  constructor(
    private readonly automation: BrowserAutomationAuthority,
    private readonly inspection: BrowserInspectionController,
    private readonly host: BrowserOpenHost,
  ) {}

  async open(url: string, options: BrowserOpenUrlOptions = {}): Promise<BrowserTabMetadata> {
    return this.openAllowed(assertBrowserAgentUrl(url), options);
  }

  private async openAllowed(
    url: string,
    options: BrowserOpenUrlOptions,
    approvedOrigin: string | null = null,
  ): Promise<BrowserTabMetadata> {
    const scopeId = options.scopeId ?? null;
    const activeTabId = options.newTab === true ? null : this.host.activeTabId(scopeId);
    const targetTabId = options.tabId ?? activeTabId;
    if (targetTabId) this.automation.assertShared(targetTabId, scopeId);
    const metadata = targetTabId
      ? this.host.navigate(targetTabId, url)
      : this.host.createAgentTab(url, scopeId);
    const tab = this.host.requireTab(metadata.id);
    // Approval belongs to the requested origin, never a redirect destination.
    tab.externalAutomationOrigin = approvedOrigin;
    await this.inspection.waitForLoad(metadata.id);
    const finalUrl = tab.webContents.getURL();
    assertBrowserAgentUrl(finalUrl, approvedOrigin !== null);
    if (approvedOrigin !== null && originOf(finalUrl) !== approvedOrigin) {
      tab.externalAutomationOrigin = null;
      throw new Error(
        "Browser redirected outside the approved origin. Approve the final URL to automate it.",
      );
    }
    this.automation.assert(metadata.id, scopeId);
    return this.host.requireTab(metadata.id).metadata;
  }

  async openExternal(
    url: string,
    options: BrowserOpenUrlOptions = {},
  ): Promise<BrowserTabMetadata> {
    const approvedUrl = assertBrowserAgentUrl(url, true);
    return this.openAllowed(approvedUrl, options, originOf(approvedUrl));
  }
}
