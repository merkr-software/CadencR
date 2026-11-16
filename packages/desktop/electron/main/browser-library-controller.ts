import { isHttpBrowserUrl } from "../../src/shared/browser-url";
import { BrowserLibraryStore } from "./browser-library-store";
import { removeLegacyOriginHistory } from "./browser-legacy-origins";
import type { ManagedTab } from "./browser-tab-events";
import type { BrowserBookmark, BrowserOmniboxQueryResult } from "./browser-types";

interface RecordedPage {
  url: string;
  title: string;
}

interface PendingTitle extends RecordedPage {
  timer: ReturnType<typeof setTimeout>;
  scopeId: number | null;
}

const TITLE_SETTLE_MS = 200;

/** Applies privacy and live-tab policy around the persistent browser library. */
export class BrowserLibraryController {
  private readonly recordedPages = new Map<string, RecordedPage>();
  private readonly pendingTitles = new Map<string, PendingTitle>();

  constructor(
    private readonly store: BrowserLibraryStore,
    private readonly requireTab: (tabId: string) => ManagedTab,
    private readonly reportError: (message: string, scopeId: number | null) => void,
    private readonly removeLegacyOrigins: () => Promise<void> = removeLegacyOriginHistory,
  ) {}

  query(query: string, limit?: number): Promise<BrowserOmniboxQueryResult> {
    return this.store.query(query, limit);
  }

  getBookmark(url: string): Promise<BrowserBookmark | null> {
    return this.store.getBookmark(url);
  }

  removeHistoryEntry(id: string): Promise<void> {
    return this.store.removeHistoryEntry(id);
  }

  async clearHistory(): Promise<void> {
    await this.store.clearHistory();
    await this.removeLegacyOrigins();
  }

  setBookmark(tabId: string, bookmarked: boolean): Promise<BrowserBookmark | null> {
    const tab = this.requireTab(tabId);
    if (tab.profile.mode !== "persistent") {
      throw new Error("Private and feature-isolated tabs cannot be bookmarked.");
    }
    return this.store.setBookmark(
      tab.webContents.getURL(),
      tab.webContents.getTitle() || tab.webContents.getURL(),
      bookmarked,
    );
  }

  recordNavigation(tab: ManagedTab, url: string, title: string): void {
    if (tab.profile.mode !== "persistent") return;
    this.clearPendingTitle(tab.metadata.id);
    if (!isHttpBrowserUrl(url)) return;
    this.recordedPages.set(tab.metadata.id, { url, title });
    this.runBackground(
      () => this.store.recordHistoryNavigation(url, title),
      "Could not save Browser history",
      tab.metadata.scopeId,
    );
  }

  updateTitle(tab: ManagedTab, url: string, title: string): void {
    if (tab.profile.mode !== "persistent" || !isHttpBrowserUrl(url)) return;
    const recorded = this.recordedPages.get(tab.metadata.id);
    if (!recorded || recorded.url !== url || recorded.title === title) return;
    this.recordedPages.set(tab.metadata.id, { url, title });
    this.clearPendingTitle(tab.metadata.id);
    const timer = setTimeout(() => this.flushTitle(tab.metadata.id), TITLE_SETTLE_MS);
    this.pendingTitles.set(tab.metadata.id, { timer, url, title, scopeId: tab.metadata.scopeId });
  }

  forget(tabId: string): void {
    this.clearPendingTitle(tabId);
    this.recordedPages.delete(tabId);
  }

  private flushTitle(tabId: string): void {
    const pending = this.pendingTitles.get(tabId);
    if (!pending) return;
    this.pendingTitles.delete(tabId);
    this.runBackground(
      () => this.store.updateHistoryTitle(pending.url, pending.title),
      "Could not update Browser history",
      pending.scopeId,
    );
  }

  private clearPendingTitle(tabId: string): void {
    const pending = this.pendingTitles.get(tabId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingTitles.delete(tabId);
  }

  private runBackground(
    operation: () => Promise<unknown>,
    context: string,
    scopeId: number | null,
  ): void {
    try {
      void operation().catch((error: unknown) => {
        this.reportError(errorMessage(context, error), scopeId);
      });
    } catch (error) {
      this.reportError(errorMessage(context, error), scopeId);
    }
  }
}

function errorMessage(context: string, error: unknown): string {
  return `${context}: ${error instanceof Error ? error.message : String(error)}`;
}
