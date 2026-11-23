import { httpBrowserOrigin } from "../../src/shared/browser-url";
import type { BrowserAutomationAuthority } from "./browser-automation-authority";
import type { BrowserInspectionController } from "./browser-inspection-controller";
import { assertBrowserAgentUrl } from "./browser-policy";
import type { ManagedTab } from "./browser-tab-events";
import type { BrowserOpenUrlOptions, BrowserTabMetadata } from "./browser-types";

export interface EnsureAgentAccessOptions {
  allowBlank?: boolean;
  targetUrl?: string;
  signal?: AbortSignal;
}

export interface BrowserOpenHost {
  activeTabId(scopeId: number | null): string | null;
  navigate(tabId: string, url: string): BrowserTabMetadata;
  createAgentTab(url: string, scopeId: number | null): BrowserTabMetadata;
  requireTab(tabId: string): ManagedTab;
  ensureAgentAccess?: (
    tabId: string,
    scopeId: number | null,
    options?: EnsureAgentAccessOptions,
  ) => Promise<void>;
}

/** Provider-neutral agent URL opening with per-scope authorization checks. */
export class BrowserOpenController {
  constructor(
    private readonly automation: BrowserAutomationAuthority,
    private readonly inspection: BrowserInspectionController,
    private readonly host: BrowserOpenHost,
  ) {}

  async open(
    url: string,
    options: BrowserOpenUrlOptions = {},
    signal?: AbortSignal,
  ): Promise<BrowserTabMetadata> {
    return this.openAllowed(assertBrowserAgentUrl(url), options, null, signal);
  }

  private async openAllowed(
    url: string,
    options: BrowserOpenUrlOptions,
    approvedOrigin: string | null,
    signal?: AbortSignal,
  ): Promise<BrowserTabMetadata> {
    const scopeId = options.scopeId ?? null;
    const activeTabId = options.newTab === true ? null : this.host.activeTabId(scopeId);
    const targetTabId = options.tabId ?? activeTabId;
    let metadata: BrowserTabMetadata;
    if (targetTabId) {
      if (this.host.ensureAgentAccess && !this.automation.isSharedOrAgent(targetTabId, scopeId)) {
        await this.host.ensureAgentAccess(targetTabId, scopeId, {
          allowBlank: true,
          targetUrl: url,
          signal,
        });
      }
      const existing = this.automation.assertShared(targetTabId, scopeId);
      // Set the intended origin before navigating so did-start-navigation treats
      // this agent navigation on a shared tab as authorized, while redirects
      // outside the origin still clear it and revoke sharing.
      existing.externalAutomationOrigin =
        approvedOrigin ?? (existing.automationAccess === "shared" ? httpBrowserOrigin(url) : null);
      metadata = this.host.navigate(targetTabId, url);
    } else {
      metadata = this.host.createAgentTab(url, scopeId);
      const created = this.host.requireTab(metadata.id);
      // Approval belongs to the requested origin, never a redirect destination.
      created.externalAutomationOrigin = approvedOrigin;
    }
    const tab = this.host.requireTab(metadata.id);
    await this.inspection.waitForLoad(metadata.id);
    const finalUrl = tab.webContents.getURL();
    assertBrowserAgentUrl(finalUrl, approvedOrigin !== null);
    if (approvedOrigin !== null && httpBrowserOrigin(finalUrl) !== approvedOrigin) {
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
    signal?: AbortSignal,
  ): Promise<BrowserTabMetadata> {
    const approvedUrl = assertBrowserAgentUrl(url, true);
    return this.openAllowed(approvedUrl, options, httpBrowserOrigin(approvedUrl), signal);
  }
}
