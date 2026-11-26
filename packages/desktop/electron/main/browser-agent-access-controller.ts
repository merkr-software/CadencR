import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { httpBrowserOrigin } from "../../src/shared/browser-url";
import { applyTabAgentAccess } from "./browser-manager-utils";
import { privacyForProfileMode, privacyFromProfileId } from "./browser-profiles";
import type { ManagedTab } from "./browser-tab-events";
import type { BrowserAgentAccessRequest, BrowserTabMetadata } from "./browser-types";

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const NO_WORKSPACE_UI_ERROR =
  "Browser tab is not shared with the agent and has no workspace UI to request approval.";
const CANCELLED_ERROR = "Browser agent access request was cancelled.";

export interface BrowserAgentAccessRequestOptions {
  targetUrl?: string;
  signal?: AbortSignal;
}

interface PendingAccessRequest {
  request: BrowserAgentAccessRequest;
  tab: ManagedTab | null;
  timer: ReturnType<typeof setTimeout> | null;
  deferred: PromiseWithResolvers<void>;
  waiterCount: number;
  sent: boolean;
  settled: boolean;
}

export interface BrowserAgentAccessControllerOptions {
  send: (
    channel: "browser:agent-access-request" | "browser:agent-access-request-cancelled",
    payload: BrowserAgentAccessRequest | { requestId: string },
  ) => void;
  activateTab: (tabId: string) => Promise<BrowserTabMetadata> | BrowserTabMetadata;
  emitState: (scopeId: number | null) => void;
  suspendFocusGuard?: <T>(action: () => Promise<T>) => Promise<T>;
  requestTimeoutMs?: number;
}

/** Coordinates explicit user approval before an agent may inspect or automate a user tab. */
export class BrowserAgentAccessController {
  private readonly pending = new Map<string, PendingAccessRequest>();
  private readonly watchedWebContents = new WeakSet<WebContents>();
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: BrowserAgentAccessControllerOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  watch(tab: ManagedTab): void {
    const wc = tab.webContents;
    if (this.watchedWebContents.has(wc)) return;
    this.watchedWebContents.add(wc);
    const tabId = tab.metadata.id;
    const onNavigate = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
      if (details.isMainFrame && !details.isSameDocument) {
        this.cancelTab(tabId, "The browser tab navigated away before agent access was approved.");
      }
    };
    wc.on("did-start-navigation", onNavigate);
    wc.once("destroyed", () => {
      wc.off("did-start-navigation", onNavigate);
      this.cancelTab(tabId, "The browser tab was closed before agent access was approved.");
    });
  }

  list(scopeId: number | null): BrowserAgentAccessRequest[] {
    const requests: BrowserAgentAccessRequest[] = [];
    for (const entry of this.pending.values()) {
      if (entry.request.scopeId === scopeId) requests.push(entry.request);
    }
    return requests;
  }

  async requestAccess(
    tab: ManagedTab,
    options: BrowserAgentAccessRequestOptions = {},
  ): Promise<void> {
    if (tab.automationAccess !== "user") return;
    if (tab.metadata.scopeId === null) throw new Error(NO_WORKSPACE_UI_ERROR);
    if (tab.webContents.isDestroyed()) throw new Error("Browser tab is no longer available.");
    if (options.signal?.aborted) throw new Error(CANCELLED_ERROR);

    const existing = this.findByTab(tab.metadata.id);
    if (existing) {
      this.mergeTargetUrl(existing, options.targetUrl);
      return this.waitForEntry(existing, options.signal);
    }

    const entry = createPendingEntry(tab, buildLiveRequest(tab, options.targetUrl));
    this.pending.set(entry.request.requestId, entry);

    if (!tab.metadata.isActive) {
      try {
        await this.options.activateTab(tab.metadata.id);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        this.failEntry(entry, failure, false);
        throw failure;
      }
    }

    if (entry.settled) return entry.deferred.promise;
    if (tab.webContents.isDestroyed()) {
      const failure = new Error("The browser tab was closed before agent access was approved.");
      this.failEntry(entry, failure, false);
      throw failure;
    }
    if (options.signal?.aborted && entry.waiterCount === 0) {
      const failure = new Error(CANCELLED_ERROR);
      this.failEntry(entry, failure, false);
      throw failure;
    }

    this.startPendingPrompt(entry);
    return this.waitForEntry(entry, options.signal);
  }

  requestDormantAccess(
    metadata: BrowserTabMetadata,
    options: BrowserAgentAccessRequestOptions = {},
  ): Promise<void> {
    if (metadata.scopeId === null) return Promise.reject(new Error(NO_WORKSPACE_UI_ERROR));
    if (options.signal?.aborted) return Promise.reject(new Error(CANCELLED_ERROR));

    const existing = this.findByTab(metadata.id);
    if (existing) {
      this.mergeTargetUrl(existing, options.targetUrl);
      return this.waitForEntry(existing, options.signal);
    }

    const entry = createPendingEntry(null, buildDormantRequest(metadata, options.targetUrl));
    this.pending.set(entry.request.requestId, entry);
    this.startPendingPrompt(entry);
    return this.waitForEntry(entry, options.signal);
  }

  resolve(requestId: string, allowed: boolean): void {
    const entry = this.pending.get(requestId);
    if (!entry) {
      this.options.send("browser:agent-access-request-cancelled", { requestId });
      if (!allowed) return;
      throw new Error("This agent access request is no longer active.");
    }
    if (!allowed) {
      this.failEntry(entry, new Error("The user denied agent access to this browser tab."), true);
      return;
    }
    if (entry.tab && !matchesRequestedPage(entry.tab, entry.request)) {
      const error = new Error("The page changed before agent access was approved.");
      this.failEntry(entry, error, true);
      throw error;
    }

    this.detachEntry(entry);
    entry.settled = true;
    if (entry.tab) {
      const { tab, request } = entry;
      if (applyTabAgentAccess(tab, true, request.origin)) {
        this.options.emitState(tab.metadata.scopeId);
      }
    }
    entry.deferred.resolve();
  }

  /** Immediately settle any pending request when sharing changes via Site Info. */
  syncExternalAccessChange(tabId: string, shared: boolean): void {
    const entry = this.findByTab(tabId);
    if (!entry) return;
    if (!shared) {
      this.failEntry(entry, new Error("The user denied agent access to this browser tab."), true);
      return;
    }
    this.detachEntry(entry);
    entry.settled = true;
    if (entry.sent) {
      this.options.send("browser:agent-access-request-cancelled", {
        requestId: entry.request.requestId,
      });
    }
    entry.deferred.resolve();
  }

  cancelTab(tabId: string, reason: string): void {
    const entry = this.findByTab(tabId);
    if (entry) this.failEntry(entry, new Error(reason), entry.sent);
  }

  cancelScope(scopeId: number | null, reason: string): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.request.scopeId === scopeId) {
        this.failEntry(entry, new Error(reason), entry.sent);
      }
    }
  }

  cancelAll(): void {
    for (const entry of [...this.pending.values()]) {
      this.failEntry(
        entry,
        new Error("The browser window closed before agent access was approved."),
        entry.sent,
      );
    }
  }

  private findByTab(tabId: string): PendingAccessRequest | undefined {
    for (const entry of this.pending.values()) {
      if (entry.request.tabId === tabId) return entry;
    }
    return undefined;
  }

  private mergeTargetUrl(entry: PendingAccessRequest, targetUrl: string | undefined): void {
    if (targetUrl === undefined || entry.request.targetUrl !== undefined) return;
    entry.request = { ...entry.request, targetUrl };
    if (entry.sent) this.options.send("browser:agent-access-request", entry.request);
  }

  private startPendingPrompt(entry: PendingAccessRequest): void {
    if (entry.sent || entry.settled) return;
    entry.sent = true;
    entry.timer = setTimeout(() => {
      this.failEntry(
        entry,
        new Error("Timed out waiting for user approval to access this browser tab."),
        true,
      );
    }, this.requestTimeoutMs);
    this.options.send("browser:agent-access-request", entry.request);
  }

  private waitForEntry(entry: PendingAccessRequest, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error(CANCELLED_ERROR));
    if (entry.settled) return entry.deferred.promise;
    entry.waiterCount += 1;
    const wait = (): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        let done = false;
        const cleanup = (): void => {
          if (done) return;
          done = true;
          signal?.removeEventListener("abort", onAbort);
          entry.waiterCount = Math.max(0, entry.waiterCount - 1);
        };
        const onAbort = (): void => {
          cleanup();
          if (!entry.settled && entry.waiterCount === 0) {
            this.failEntry(entry, new Error(CANCELLED_ERROR), entry.sent);
          }
          reject(new Error(CANCELLED_ERROR));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        entry.deferred.promise.then(
          () => {
            cleanup();
            resolve();
          },
          (error: unknown) => {
            cleanup();
            reject(error);
          },
        );
      });
    return this.options.suspendFocusGuard ? this.options.suspendFocusGuard(wait) : wait();
  }

  private failEntry(entry: PendingAccessRequest, error: Error, notifyCancellation: boolean): void {
    if (!this.pending.has(entry.request.requestId)) return;
    this.detachEntry(entry);
    entry.settled = true;
    if (notifyCancellation) {
      this.options.send("browser:agent-access-request-cancelled", {
        requestId: entry.request.requestId,
      });
    }
    entry.deferred.reject(error);
  }

  private detachEntry(entry: PendingAccessRequest): void {
    this.pending.delete(entry.request.requestId);
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }
}

function createPendingEntry(
  tab: ManagedTab | null,
  request: BrowserAgentAccessRequest,
): PendingAccessRequest {
  const deferred = Promise.withResolvers<void>();
  deferred.promise.catch(() => undefined);
  return { request, tab, timer: null, deferred, waiterCount: 0, sent: false, settled: false };
}

function buildLiveRequest(tab: ManagedTab, targetUrl?: string): BrowserAgentAccessRequest {
  const liveUrl = currentTabUrl(tab);
  return {
    requestId: randomUUID(),
    tabId: tab.metadata.id,
    scopeId: tab.metadata.scopeId,
    origin: httpBrowserOrigin(liveUrl),
    url: liveUrl,
    title: tab.metadata.title || liveUrl,
    privacy: privacyForProfileMode(tab.profile.mode),
    ...(targetUrl !== undefined ? { targetUrl } : {}),
  };
}

function buildDormantRequest(
  metadata: BrowserTabMetadata,
  targetUrl?: string,
): BrowserAgentAccessRequest {
  return {
    requestId: randomUUID(),
    tabId: metadata.id,
    scopeId: metadata.scopeId,
    origin: httpBrowserOrigin(metadata.url),
    url: metadata.url,
    title: metadata.title || metadata.url,
    privacy: privacyFromProfileId(metadata.sessionProfileId),
    ...(targetUrl !== undefined ? { targetUrl } : {}),
  };
}

function currentTabUrl(tab: ManagedTab): string {
  return tab.webContents.getURL() || tab.metadata.url;
}

function matchesRequestedPage(tab: ManagedTab, request: BrowserAgentAccessRequest): boolean {
  if (tab.webContents.isDestroyed()) return false;
  const liveUrl = currentTabUrl(tab);
  const liveOrigin = httpBrowserOrigin(liveUrl);
  if (request.origin === null) {
    return liveOrigin === null && liveUrl === request.url;
  }
  return liveOrigin === request.origin;
}
