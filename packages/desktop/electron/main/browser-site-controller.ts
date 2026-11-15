import { randomUUID } from "node:crypto";
import type { Session, WebContents } from "electron";
import { browserPartitionForProfile, type BrowserProfile } from "./browser-profiles";
import { BrowserSitePermissionStore } from "./browser-site-permission-store";
import { BrowserSiteDecisions } from "./browser-site-decisions";
import { clearDataForOrigin } from "./browser-site-data";
import {
  checkPermissions,
  originOf,
  profileMetadata,
  requestOriginIsConsistent,
  requestPermissions,
  siteKey,
} from "./browser-site-permission-policy";
import type {
  BrowserSiteInfo,
  BrowserSitePermission,
  BrowserSitePermissionDecision,
  BrowserSitePermissionRequest,
} from "./browser-types";
import type { ManagedTab } from "./browser-tab-events";

const REQUEST_TIMEOUT_MS = 60_000;

export type BrowserSiteTab = Pick<
  ManagedTab,
  "metadata" | "profile" | "automationAccess" | "webContents"
>;

interface RegisteredTab {
  tab: BrowserSiteTab;
  session: Session;
  partition: string;
}

interface SessionRegistration {
  partition: string;
  webContentsIds: Set<number>;
}

interface PendingRequest {
  request: BrowserSitePermissionRequest;
  webContentsId: number;
  callback: (allowed: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  partition: string;
}

export interface BrowserSiteControllerOptions {
  send: (
    channel: "browser:permission-request" | "browser:permission-request-cancelled",
    payload: BrowserSitePermissionRequest | { requestId: string },
  ) => void;
  reportError: (message: string, tab: Pick<ManagedTab, "metadata">) => void;
  store?: BrowserSitePermissionStore;
  requestTimeoutMs?: number;
}

export class BrowserSiteController {
  private readonly tabsByWebContents = new Map<number, RegisteredTab>();
  private readonly sessions = new Map<Session, SessionRegistration>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly clearingSites = new Set<string>();
  private readonly decisions: BrowserSiteDecisions;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: BrowserSiteControllerOptions) {
    this.decisions = new BrowserSiteDecisions(
      options.store ?? new BrowserSitePermissionStore(),
      options.reportError,
    );
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  registerTab(tab: BrowserSiteTab): void {
    const wc = tab.webContents;
    const targetSession = wc.session;
    const partition = browserPartitionForProfile(tab.profile);
    const existing = this.sessions.get(targetSession);
    if (existing && existing.partition !== partition) {
      throw new Error("Browser session partition does not match its tab profile.");
    }
    if (!existing) this.installSessionHandlers(targetSession, partition);
    this.sessions.get(targetSession)?.webContentsIds.add(wc.id);
    this.tabsByWebContents.set(wc.id, { tab, session: targetSession, partition });
    const webContentsId = wc.id;
    wc.on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) this.cancelRequestsFor(webContentsId);
    });
    wc.once("destroyed", () => this.unregisterWebContents(webContentsId, tab.profile.mode));
  }

  private unregisterWebContents(webContentsId: number, profileMode: BrowserProfile["mode"]): void {
    this.cancelRequestsFor(webContentsId);
    const registered = this.tabsByWebContents.get(webContentsId);
    this.tabsByWebContents.delete(webContentsId);
    if (!registered) return;
    const sessionRegistration = this.sessions.get(registered.session);
    sessionRegistration?.webContentsIds.delete(webContentsId);
    if (sessionRegistration && sessionRegistration.webContentsIds.size === 0) {
      // Keep fail-closed handlers: Sessions can outlive tabs via service workers.
      this.sessions.delete(registered.session);
      if (profileMode !== "persistent") {
        this.decisions.deletePrivatePartition(registered.partition);
      }
    }
  }

  info(tab: BrowserSiteTab): BrowserSiteInfo {
    const origin = liveOrigin(tab);
    return {
      tabId: tab.metadata.id,
      origin,
      secure: origin?.startsWith("https://") === true,
      profile: profileMetadata(tab.profile),
      privacy:
        tab.profile.mode === "persistent"
          ? "normal"
          : tab.profile.mode === "fresh"
            ? "private"
            : "feature",
      permissions: this.decisions.forOrigin(tab, origin),
      agentAccess: tab.automationAccess,
    };
  }

  setPermissionDecision(
    tab: BrowserSiteTab,
    origin: string,
    permission: BrowserSitePermission,
    decision: BrowserSitePermissionDecision,
  ): BrowserSiteInfo {
    this.requireCurrentOrigin(tab, origin);
    this.cancelRequestsForSite(browserPartitionForProfile(tab.profile), origin);
    this.decisions.set(tab.profile, origin, permission, decision);
    return this.info(tab);
  }

  setAgentAccess(tab: BrowserSiteTab, origin: string, shared: boolean): BrowserSiteInfo {
    this.requireCurrentOrigin(tab, origin);
    tab.automationAccess = shared ? "shared" : "user";
    return this.info(tab);
  }

  async clearSiteData(tab: BrowserSiteTab, origin: string): Promise<BrowserSiteInfo> {
    this.requireCurrentOrigin(tab, origin);
    const partition = browserPartitionForProfile(tab.profile);
    const key = siteKey(partition, origin);
    if (this.clearingSites.has(key)) {
      throw new Error("Site data is already being cleared for this origin.");
    }
    this.clearingSites.add(key);
    this.cancelRequestsForSite(partition, origin);
    try {
      await clearDataForOrigin(tab.webContents.session, origin);
      this.decisions.deleteOrigin(tab.profile, origin);
    } finally {
      this.clearingSites.delete(key);
    }
    return this.info(tab);
  }

  resolvePermissionRequest(requestId: string, allowed: boolean): void {
    const pending = this.pending.get(requestId);
    if (!pending) {
      if (!allowed) return;
      throw new Error("This browser permission request is no longer active.");
    }
    const registration = this.tabsByWebContents.get(pending.webContentsId);
    if (!registration || !sameLiveOrigin(registration.tab, pending.request.topOrigin)) {
      this.finishRequest(requestId, false, true);
      throw new Error("The page changed before the browser permission request was answered.");
    }
    const currentDecisions = pending.request.permissions.map((permission) =>
      this.decisions.safeGet(registration.tab, pending.request.origin, permission),
    );
    if (currentDecisions.includes("deny")) {
      this.finishRequest(requestId, false, true);
      throw new Error("The website permission was blocked while the request was open.");
    }
    try {
      this.decisions.setMany(
        registration.tab.profile,
        pending.request.origin,
        pending.request.permissions.map(
          (permission) => [permission, allowed ? "allow" : "deny"] as const,
        ),
      );
    } catch (error) {
      this.finishRequest(requestId, false, true);
      throw error;
    }
    this.finishRequest(requestId, allowed, false);
  }

  private installSessionHandlers(targetSession: Session, partition: string): void {
    this.sessions.set(targetSession, {
      partition,
      webContentsIds: new Set(),
    });
    targetSession.setPermissionRequestHandler((wc, permission, callback, details) => {
      this.handlePermissionRequest(targetSession, wc, permission, details, callback);
    });
    targetSession.setPermissionCheckHandler((wc, permission, requestingOrigin, details) =>
      this.handlePermissionCheck(targetSession, wc, permission, requestingOrigin, details),
    );
  }

  private handlePermissionRequest(
    targetSession: Session,
    wc: WebContents,
    permission: string,
    details: Electron.PermissionRequest,
    callback: (allowed: boolean) => void,
  ): void {
    const registration = this.validRegistration(targetSession, wc);
    const requested = requestPermissions(permission, details);
    const origin = originOf(details.requestingUrl);
    const topOrigin = registration ? liveOrigin(registration.tab) : null;
    if (
      !registration ||
      !origin ||
      !topOrigin ||
      origin !== topOrigin ||
      !requestOriginIsConsistent(permission, details, origin) ||
      requested.length === 0
    ) {
      callback(false);
      return;
    }
    if (this.clearingSites.has(siteKey(registration.partition, origin))) {
      callback(false);
      return;
    }
    const decisions = requested.map((item) =>
      this.decisions.safeGet(registration.tab, origin, item),
    );
    if (decisions.includes("deny")) {
      callback(false);
      return;
    }
    if (decisions.every((decision) => decision === "allow")) {
      callback(true);
      return;
    }
    if (this.hasPendingRequest(wc.id)) {
      callback(false);
      return;
    }
    const request: BrowserSitePermissionRequest = {
      requestId: randomUUID(),
      tabId: registration.tab.metadata.id,
      scopeId: registration.tab.metadata.scopeId,
      origin,
      topOrigin,
      permissions: requested,
    };
    const timer = setTimeout(
      () => this.finishRequest(request.requestId, false, true),
      this.requestTimeoutMs,
    );
    this.pending.set(request.requestId, {
      request,
      webContentsId: wc.id,
      callback,
      timer,
      partition: registration.partition,
    });
    this.options.send("browser:permission-request", request);
  }

  private handlePermissionCheck(
    targetSession: Session,
    wc: WebContents | null,
    permission: string,
    requestingOrigin: string,
    details: Electron.PermissionCheckHandlerHandlerDetails,
  ): boolean {
    if (!wc) return false;
    const registration = this.validRegistration(targetSession, wc);
    const origin = originOf(requestingOrigin);
    const topOrigin = registration ? liveOrigin(registration.tab) : null;
    const requested = checkPermissions(permission, details);
    if (
      !registration ||
      !origin ||
      !topOrigin ||
      origin !== topOrigin ||
      requested.length === 0 ||
      this.clearingSites.has(siteKey(registration.partition, origin))
    ) {
      return false;
    }
    return requested.every(
      (item) => this.decisions.safeGet(registration.tab, origin, item) === "allow",
    );
  }

  private validRegistration(targetSession: Session, wc: WebContents): RegisteredTab | null {
    const registration = this.tabsByWebContents.get(wc.id);
    if (!registration || registration.session !== targetSession || wc.session !== targetSession) {
      return null;
    }
    if (registration.tab.webContents !== wc || wc.isDestroyed()) return null;
    return registration;
  }

  private requireCurrentOrigin(tab: BrowserSiteTab, expectedOrigin: string): void {
    const origin = originOf(expectedOrigin);
    if (!origin || origin !== expectedOrigin || !sameLiveOrigin(tab, origin)) {
      throw new Error("The browser tab is no longer on this site.");
    }
  }

  private cancelRequestsFor(webContentsId: number): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.webContentsId === webContentsId) this.finishRequest(requestId, false, true);
    }
  }

  private hasPendingRequest(webContentsId: number): boolean {
    for (const pending of this.pending.values()) {
      if (pending.webContentsId === webContentsId) return true;
    }
    return false;
  }

  private cancelRequestsForSite(partition: string, origin: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.partition === partition && pending.request.origin === origin) {
        this.finishRequest(requestId, false, true);
      }
    }
  }

  private finishRequest(requestId: string, allowed: boolean, notifyCancellation: boolean): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.callback(allowed);
    if (notifyCancellation) {
      this.options.send("browser:permission-request-cancelled", { requestId });
    }
  }
}

function sameLiveOrigin(tab: BrowserSiteTab, origin: string): boolean {
  return liveOrigin(tab) === origin;
}

function liveOrigin(tab: BrowserSiteTab): string | null {
  if (tab.webContents.isDestroyed()) return null;
  return originOf(tab.webContents.getURL());
}
