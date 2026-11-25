import { translateUi } from "../../src/shared/ui-i18n";
import { randomUUID } from "node:crypto";
import { shell, type BrowserWindow, type HandlerDetails, type WebContents } from "electron";
import { normalizeBrowserOpenUrl } from "./browser-policy";
import { secureChildWebPreferences } from "./browser-manager-utils";
import type { ManagedTab } from "./browser-tab-events";
import type { BrowserPopupRequest } from "./browser-types";
import { sendToWindow } from "./safe-send";

const USER_GESTURE_MS = 1_000;
const ALLOW_ONCE_MS = 30_000;
const MAX_BLOCKED_REQUESTS = 20;

interface InternalPopupRequest {
  public: BrowserPopupRequest;
  url: string;
  topOrigin: string | null;
}

interface PopupGrant {
  topOrigin: string | null;
  expiresAt: number;
}

interface BrowserPopupHost {
  getWindow(): BrowserWindow | null;
  currentUrl(tabId: string): string | null;
  assertCanCreateNative(parent: ManagedTab, temporary: boolean): void;
  createNativeChild(
    parent: ManagedTab,
    details: HandlerDetails,
    options: Electron.BrowserWindowConstructorOptions,
    background: boolean,
    temporary: boolean,
  ): WebContents;
  reportError(error: unknown, scopeId: number | null): void;
}

/** Owns native child-window semantics and bounded, one-shot popup consent. */
export class BrowserPopupController {
  private readonly blocked = new Map<string, InternalPopupRequest>();
  private readonly blockedByTab = new Map<string, string>();
  private readonly grants = new Map<string, PopupGrant>();
  private readonly grantTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly host: BrowserPopupHost) {}

  watch(tab: ManagedTab): void {
    const wc = tab.webContents;
    wc.on("before-mouse-event", (_event, input) => {
      if (input.type !== "mouseDown" || (input.button !== "left" && input.button !== "middle")) {
        return;
      }
      this.noteGesture(tab, "mouse");
    });
    wc.on("before-input-event", (_event, input) => {
      if (input.type !== "keyDown") return;
      if (this.consumeSyntheticInput(tab, "key")) {
        tab.popupGestureAt = null;
        return;
      }
      if (
        !input.meta &&
        !input.control &&
        !input.alt &&
        (input.key === "Enter" || input.key === " ")
      ) {
        this.noteGesture(tab, "key");
      }
    });
    wc.on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) this.revokeForNavigation(tab);
    });
    wc.once("destroyed", () => this.forgetTab(tab));
    wc.setWindowOpenHandler((details) => this.handle(tab, details));
  }

  list(scopeId: number): BrowserPopupRequest[] {
    return [...this.blocked.values()]
      .map((request) => request.public)
      .filter((request) => request.scopeId === scopeId);
  }

  allowOnce(requestId: string): void {
    const request = this.requireRequest(requestId);
    const currentUrl = this.host.currentUrl(request.public.tabId);
    const currentOrigin = currentUrl ? origin(currentUrl) : null;
    if (currentOrigin !== request.topOrigin) {
      this.removeRequest(request);
      throw new Error(
        translateUi(
          "workspace.browser.popup.pageChanged",
          "The page changed. Retry the sign-in action before allowing its popup.",
        ),
      );
    }
    const expiresAt = Date.now() + ALLOW_ONCE_MS;
    this.clearGrant(request.public.tabId);
    this.grants.set(request.public.tabId, {
      topOrigin: request.topOrigin,
      expiresAt,
    });
    request.public = {
      ...request.public,
      status: "allowed-once",
      allowExpiresAt: new Date(expiresAt).toISOString(),
    };
    this.grantTimers.set(
      request.public.tabId,
      setTimeout(() => this.expireGrant(request.public.tabId), ALLOW_ONCE_MS),
    );
    this.emitChanged(request.public.scopeId);
  }

  dismiss(requestId: string): void {
    this.removeRequest(this.requireRequest(requestId));
  }

  consumeFocusGesture(parent: ManagedTab): boolean {
    return this.consumeGesture(parent);
  }

  async openExternal(requestId: string): Promise<void> {
    const request = this.requireRequest(requestId);
    assertSafePopupExternalUrl(request.url);
    await shell.openExternal(request.url);
  }

  private handle(tab: ManagedTab, details: HandlerDetails): Electron.WindowOpenHandlerResponse {
    const gesture = this.consumeGesture(tab);
    const grant = this.consumeGrant(tab);
    try {
      assertNativePopupUrl(tab.webContents.getURL(), details.url);
    } catch (error) {
      console.debug("[browser] popup URL denied", details.url, error);
      return { action: "deny" };
    }
    const allowed = gesture || grant;
    if (!allowed) {
      this.recordBlocked(tab, details);
      return { action: "deny" };
    }
    const temporary = popupIsTemporary(details);
    try {
      this.host.assertCanCreateNative(tab, temporary);
    } catch (error) {
      this.host.reportError(error, tab.metadata.scopeId);
      return { action: "deny" };
    }
    this.clearBlocked(tab.metadata.id);
    const background = details.disposition === "background-tab";
    return {
      action: "allow",
      // The manager owns temporary-child closure explicitly so a later
      // user-driven promotion can detach that relationship safely.
      outlivesOpener: true,
      // Electron merges this before it creates a native child WebContents. An
      // adopted child cannot be hardened after construction, so enforce the
      // parent's exact partition and privilege boundary at this stage too.
      overrideBrowserWindowOptions: { webPreferences: secureChildWebPreferences(tab.profile) },
      createWindow: (options) => {
        try {
          return this.host.createNativeChild(tab, details, options, background, temporary);
        } catch (error) {
          this.host.reportError(error, tab.metadata.scopeId);
          throw error;
        }
      },
    };
  }

  private noteGesture(tab: ManagedTab, kind: "mouse" | "key"): void {
    if (this.consumeSyntheticInput(tab, kind)) {
      tab.popupGestureAt = null;
      return;
    }
    tab.popupGestureAt = Date.now();
  }

  private consumeSyntheticInput(tab: ManagedTab, kind: "mouse" | "key"): boolean {
    this.expireSyntheticInput(tab);
    const budget = kind === "key" ? "syntheticPopupKeyEvents" : "syntheticPopupMouseEvents";
    if (tab[budget] === 0) return false;
    tab[budget] -= 1;
    return true;
  }

  private consumeGesture(tab: ManagedTab): boolean {
    const at = tab.popupGestureAt;
    tab.popupGestureAt = null;
    return at !== null && Date.now() - at <= USER_GESTURE_MS;
  }

  private consumeGrant(tab: ManagedTab): boolean {
    const grant = this.grants.get(tab.metadata.id);
    this.clearGrant(tab.metadata.id);
    if (!grant || grant.expiresAt < Date.now()) return false;
    return grant.topOrigin === origin(tab.webContents.getURL());
  }

  private recordBlocked(tab: ManagedTab, details: HandlerDetails): void {
    this.clearBlocked(tab.metadata.id);
    const id = randomUUID();
    const request: InternalPopupRequest = {
      public: {
        id,
        tabId: tab.metadata.id,
        scopeId: tab.metadata.scopeId,
        origin: origin(details.url) ?? "Unknown origin",
        hasPostData: details.postBody !== undefined && details.postBody !== null,
        externalAvailable: isSafePopupExternalUrl(details.url),
        status: "blocked",
      },
      url: details.url,
      topOrigin: origin(tab.webContents.getURL()),
    };
    this.blocked.set(id, request);
    this.blockedByTab.set(tab.metadata.id, id);
    while (this.blocked.size > MAX_BLOCKED_REQUESTS) {
      const oldest = this.blocked.values().next().value as InternalPopupRequest | undefined;
      if (!oldest) break;
      this.removeRequest(oldest);
    }
    this.emitChanged(tab.metadata.scopeId);
  }

  private revokeForNavigation(tab: ManagedTab): void {
    tab.popupGestureAt = null;
    this.clearGrant(tab.metadata.id);
    this.clearBlocked(tab.metadata.id);
  }

  private forgetTab(tab: ManagedTab): void {
    tab.popupGestureAt = null;
    this.clearGrant(tab.metadata.id);
    this.clearBlocked(tab.metadata.id);
  }

  private requireRequest(requestId: string): InternalPopupRequest {
    const request = this.blocked.get(requestId);
    if (!request)
      throw new Error(
        translateUi(
          "workspace.browser.popup.gone",
          "This blocked popup request is no longer available.",
        ),
      );
    return request;
  }

  private clearBlocked(tabId: string): void {
    const id = this.blockedByTab.get(tabId);
    if (!id) return;
    const request = this.blocked.get(id);
    this.blocked.delete(id);
    this.blockedByTab.delete(tabId);
    if (request) this.emitChanged(request.public.scopeId);
  }

  private removeRequest(request: InternalPopupRequest): void {
    this.blocked.delete(request.public.id);
    if (this.blockedByTab.get(request.public.tabId) === request.public.id) {
      this.blockedByTab.delete(request.public.tabId);
    }
    this.clearGrant(request.public.tabId);
    this.emitChanged(request.public.scopeId);
  }

  private expireSyntheticInput(tab: ManagedTab): void {
    if (tab.syntheticPopupInputExpiresAt >= Date.now()) return;
    tab.syntheticPopupMouseEvents = 0;
    tab.syntheticPopupKeyEvents = 0;
    tab.syntheticPopupInputExpiresAt = 0;
  }

  private clearGrant(tabId: string): void {
    this.grants.delete(tabId);
    const timer = this.grantTimers.get(tabId);
    if (timer) clearTimeout(timer);
    this.grantTimers.delete(tabId);
  }

  private expireGrant(tabId: string): void {
    this.clearGrant(tabId);
    const requestId = this.blockedByTab.get(tabId);
    const request = requestId ? this.blocked.get(requestId) : null;
    if (!request || request.public.status !== "allowed-once") return;
    request.public = { ...request.public, status: "blocked", allowExpiresAt: undefined };
    this.emitChanged(request.public.scopeId);
  }

  private emitChanged(scopeId: number | null): void {
    if (scopeId !== null) {
      sendToWindow(this.host.getWindow(), "browser:popup-requests-changed", { scopeId });
    }
  }
}

function popupIsTemporary(details: HandlerDetails): boolean {
  return (
    (details.postBody !== undefined && details.postBody !== null) ||
    details.disposition === "new-window" ||
    (details.frameName.length > 0 && details.frameName !== "_blank")
  );
}

function assertNativePopupUrl(parentUrl: string, targetUrl: string): void {
  const target = new URL(targetUrl);
  if (target.username || target.password) {
    throw new Error(
      translateUi(
        "workspace.browser.popup.credentialsBlocked",
        "Browser popup URLs with embedded credentials are blocked.",
      ),
    );
  }
  const parent = new URL(parentUrl);
  if (
    target.protocol === "file:" &&
    (parent.protocol === "http:" || parent.protocol === "https:")
  ) {
    throw new Error(
      translateUi(
        "workspace.browser.popup.fileBlocked",
        "Web pages cannot open local files in a Browser popup.",
      ),
    );
  }
  normalizeBrowserOpenUrl(targetUrl);
}

function origin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

function isSafePopupExternalUrl(rawUrl: string): boolean {
  try {
    assertSafePopupExternalUrl(rawUrl);
    return true;
  } catch {
    return false;
  }
}

function assertSafePopupExternalUrl(rawUrl: string): void {
  const parsed = new URL(rawUrl);
  if (parsed.username || parsed.password)
    throw new Error("Popup URLs with credentials are blocked.");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error(
      translateUi(
        "workspace.browser.popup.externalAddress",
        "Only HTTPS or local HTTP popup addresses can be opened externally.",
      ),
    );
  }
}
