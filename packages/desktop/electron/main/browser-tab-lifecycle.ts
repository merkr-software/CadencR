import { randomUUID } from "node:crypto";
import { WebContentsView, type Session, type WebContents } from "electron";
import { metadataFor, secureChildWebPreferences } from "./browser-manager-utils";
import type { BrowserViewLayout } from "./browser-view-layout";
import type { BrowserProfile } from "./browser-profiles";
import { BrowserSessionLifecycle } from "./browser-session-lifecycle";
import type { ManagedTab } from "./browser-tab-events";
import type { BrowserAgentAccess } from "./browser-types";
import type { BrowserTabMetadata } from "./browser-types";

/** Constructs and destroys tabs while keeping private-session ownership exact. */
export class BrowserTabLifecycle {
  private readonly sessions = new BrowserSessionLifecycle();
  private readonly destructions = new WeakMap<ManagedTab, Promise<void>>();

  constructor(
    private readonly tabs: Map<string, ManagedTab>,
    private readonly layout: BrowserViewLayout,
  ) {}

  create(
    selectionId: string,
    profile: BrowserProfile,
    scopeId: number | null,
    automationAccess: BrowserAgentAccess,
    restoredMetadata?: BrowserTabMetadata,
    nativeOptions?: Electron.WebContentsViewConstructorOptions,
    temporary = false,
    expectedSession?: Session,
  ): ManagedTab {
    // Check before WebContentsView touches the partition, then claim immediately
    // after construction. There is no async boundary between these operations.
    this.sessions.assertAvailable(profile);
    // Electron puts its internal opener plumbing in the child preferences. Keep
    // every supplied field, then enforce Cadencr's security/session invariants.
    if (
      nativeOptions?.webContents &&
      expectedSession &&
      nativeOptions.webContents.session !== expectedSession
    ) {
      throw new Error("Native child did not inherit its parent's Browser session.");
    }
    const adopted = nativeOptions?.webContents;
    const view = new WebContentsView({
      ...(adopted ? { webContents: adopted } : {}),
      webPreferences: secureChildWebPreferences(profile, nativeOptions?.webPreferences),
    });
    const metadata = restoredMetadata ?? metadataFor(randomUUID(), selectionId, scopeId);
    const tab: ManagedTab = {
      metadata: {
        ...metadata,
        agentAccess: automationAccess,
        temporary: temporary || undefined,
      },
      automationAccess,
      profile,
      view,
      webContents: view.webContents,
      devtoolsView: null,
      devtoolsWebContents: null,
      consoleEntries: [],
      networkEntries: [],
      pendingSessionTasks: new Set(),
      temporary,
      popupGestureAt: null,
      syntheticPopupMouseEvents: 0,
      syntheticPopupKeyEvents: 0,
      syntheticPopupInputExpiresAt: 0,
      openerTabId: null,
      detachOpenerRelations: null,
      externalAutomationOrigin: null,
    };
    this.sessions.claim(profile);
    return tab;
  }

  register(tab: ManagedTab): void {
    if (tab.webContents.isDestroyed()) throw new Error("Browser tab was destroyed during setup");
    this.tabs.set(tab.metadata.id, tab);
  }

  acquireSessionLease(profile: BrowserProfile): () => Promise<void> {
    return this.sessions.acquire(profile);
  }

  destroy(tab: ManagedTab): Promise<void> {
    const pending = this.destructions.get(tab);
    if (pending) return pending;
    this.layout.detach(tab.view);
    if (tab.devtoolsView) this.layout.detach(tab.devtoolsView);
    this.tabs.delete(tab.metadata.id);
    const contents = [tab.webContents];
    if (tab.devtoolsWebContents) contents.push(tab.devtoolsWebContents);
    const destroyed = Promise.all(contents.map(waitForDestroyed))
      .then(() => waitForSessionTasks(tab))
      .then(() => this.sessions.release(tab.profile));
    this.destructions.set(tab, destroyed);
    for (const webContents of contents) {
      if (!webContents.isDestroyed()) webContents.close({ waitForBeforeUnload: false });
    }
    return destroyed;
  }
}

function waitForDestroyed(webContents: WebContents): Promise<void> {
  if (webContents.isDestroyed()) return Promise.resolve();
  return new Promise((resolve) => webContents.once("destroyed", resolve));
}

async function waitForSessionTasks(tab: ManagedTab): Promise<void> {
  while (tab.pendingSessionTasks.size > 0) {
    await Promise.all([...tab.pendingSessionTasks]);
  }
}
