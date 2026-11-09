import { ipcMain, type BrowserWindow } from "electron";
import { z } from "zod";
import {
  optionalNumber,
  optionalString,
  parseBounds,
  requiredNumber,
  requiredString,
} from "./browser-arg-validation";
import { BrowserManager } from "./browser-manager";
import { reclaimRendererFocus } from "./browser-manager-utils";
import { registerBrowserDownloadIpc } from "./browser-download-ipc";
import { parseBrowserGuestShortcutBindings } from "./browser-guest-shortcuts";
import { BrowserProfileController } from "./browser-profile-controller";
import { parseBrowserResponsiveRequest } from "./browser-responsive-schema";
import {
  BROWSER_SITE_PERMISSIONS,
  BROWSER_SITE_PERMISSION_DECISIONS,
  MAX_BROWSER_FIND_QUERY_LENGTH,
  MAX_BROWSER_LIBRARY_QUERY_LENGTH,
  MAX_BROWSER_LIBRARY_URL_LENGTH,
} from "./browser-types";
import { assertTrustedSender } from "./ipc";

interface BrowserIpcOptions {
  getMainWindow: () => BrowserWindow | null;
  /**
   * Other native views a React overlay must uncover too (custom-tab guests):
   * `useSuppressBrowserView` drives them all through `browser:set-suppressed`.
   */
  onSuppressed?: (value: boolean) => void;
}

const sitePermissionSchema = z.enum(BROWSER_SITE_PERMISSIONS);
const siteDecisionSchema = z.enum(BROWSER_SITE_PERMISSION_DECISIONS);
const findRequestSchema = z
  .object({
    requestToken: z.string().min(1).max(128),
    query: z.string().min(1).max(MAX_BROWSER_FIND_QUERY_LENGTH),
    forward: z.boolean(),
    findNext: z.boolean(),
  })
  .strict();
const libraryQuerySchema = z.string().max(MAX_BROWSER_LIBRARY_QUERY_LENGTH);
const libraryLimitSchema = z.number().int().min(1).max(20).optional();
const historyIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const libraryUrlSchema = z.string().min(1).max(MAX_BROWSER_LIBRARY_URL_LENGTH);
const tabIndexSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const siteOriginSchema = z.url().refine((value) => {
  const parsed = new URL(value);
  return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin === value;
}, "Expected an HTTP(S) origin without a path.");

function registerTabIpc(manager: BrowserManager, options: BrowserIpcOptions): void {
  const { getMainWindow } = options;
  ipcMain.handle(
    "browser:create-tab",
    async (event, rawUrl: unknown, profileId: unknown, scopeId: unknown) => {
      assertTrustedSender(event, getMainWindow);
      const parsedScopeId = optionalNumber(scopeId) ?? null;
      if (parsedScopeId !== null) await manager.restoreScope(parsedScopeId);
      return manager.createTab(
        optionalString(rawUrl),
        optionalString(profileId) ?? "fresh",
        parsedScopeId,
      );
    },
  );
  ipcMain.handle("browser:list-tabs", async (event, scopeId: unknown) => {
    assertTrustedSender(event, getMainWindow);
    const parsedScopeId = optionalNumber(scopeId) ?? null;
    return parsedScopeId === null ? manager.state(null) : manager.restoreScope(parsedScopeId);
  });
  ipcMain.handle("browser:tab-counts-by-scope", (event) => {
    assertTrustedSender(event, getMainWindow);
    return manager.tabCountsByScope();
  });
  ipcMain.handle("browser:navigate", (event, tabId: unknown, rawUrl: unknown) => {
    assertTrustedSender(event, getMainWindow);
    return manager.navigateFromChrome(
      requiredString(tabId, "tab id"),
      requiredString(rawUrl, "URL"),
    );
  });
  ipcMain.handle("browser:activate-tab", (event, tabId: unknown) => {
    assertTrustedSender(event, getMainWindow);
    return manager.activateTab(requiredString(tabId, "tab id"));
  });
  ipcMain.handle("browser:close-tab", (event, tabId: unknown) => {
    assertTrustedSender(event, getMainWindow);
    return manager.closeTab(requiredString(tabId, "tab id"));
  });
  ipcMain.handle("browser:close-tabs-for-scope", (event, scopeId: unknown) => {
    assertTrustedSender(event, getMainWindow);
    const parsedScopeId = requiredNumber(scopeId, "scope id");
    return manager
      .restoreScopeMetadata(parsedScopeId)
      .then(() => manager.closeTabsForScope(parsedScopeId));
  });
  ipcMain.handle("browser:duplicate-tab", (event, tabId: unknown) => {
    assertTrustedSender(event, getMainWindow);
    return manager.duplicateTab(requiredString(tabId, "tab id"));
  });
  ipcMain.handle("browser:set-tab-pinned", (event, tabId: unknown, pinned: unknown) => {
    assertTrustedSender(event, getMainWindow);
    return manager.setTabPinned(requiredString(tabId, "tab id"), z.boolean().parse(pinned));
  });
  ipcMain.handle("browser:reorder-tab", (event, tabId: unknown, targetIndex: unknown) => {
    assertTrustedSender(event, getMainWindow);
    return manager.reorderTab(requiredString(tabId, "tab id"), tabIndexSchema.parse(targetIndex));
  });
  ipcMain.handle("browser:close-other-tabs", (event, tabId: unknown) => {
    assertTrustedSender(event, getMainWindow);
    return manager.closeOtherTabs(requiredString(tabId, "tab id"));
  });
  ipcMain.handle("browser:reopen-last-closed-tab", async (event, scopeId: unknown) => {
    assertTrustedSender(event, getMainWindow);
    const parsedScopeId = requiredNumber(scopeId, "scope id");
    await manager.restoreScope(parsedScopeId);
    return manager.reopenLastClosedTab(parsedScopeId);
  });
  ipcMain.handle(
    "browser:set-bounds",
    (event, bounds: unknown, scopeId: unknown, zoomFactor: unknown) => {
      assertTrustedSender(event, getMainWindow);
      return manager.setBounds(
        parseBounds(bounds),
        optionalNumber(scopeId) ?? null,
        optionalNumber(zoomFactor),
      );
    },
  );
  ipcMain.handle("browser:set-suppressed", (event, value: unknown) => {
    assertTrustedSender(event, getMainWindow);
    manager.setSuppressed(value === true);
    options.onSuppressed?.(value === true);
  });
}

function registerPopupIpc(
  manager: BrowserManager,
  getMainWindow: BrowserIpcOptions["getMainWindow"],
): void {
  ipcMain.handle("browser:list-blocked-popups", (event, scopeId: unknown) => {
    assertTrustedSender(event, getMainWindow);
    return manager.popup.list(requiredNumber(scopeId, "scope id"));
  });
  ipcMain.handle("browser:allow-popup-once", (event, requestId: unknown) => {
    assertTrustedSender(event, getMainWindow);
    manager.popup.allowOnce(z.string().uuid().parse(requestId));
  });
  ipcMain.handle("browser:open-popup-externally", (event, requestId: unknown) => {
    assertTrustedSender(event, getMainWindow);
    return manager.popup.openExternal(z.string().uuid().parse(requestId));
  });
  ipcMain.handle("browser:dismiss-popup", (event, requestId: unknown) => {
    assertTrustedSender(event, getMainWindow);
    manager.popup.dismiss(z.string().uuid().parse(requestId));
  });
}

function registerProfileIpc(
  profiles: BrowserProfileController,
  getMainWindow: BrowserIpcOptions["getMainWindow"],
): void {
  ipcMain.handle("browser:list-profiles", (event) => {
    assertTrustedSender(event, getMainWindow);
    return profiles.list();
  });
  ipcMain.handle("browser:clear-storage", (event, profileId: unknown) => {
    assertTrustedSender(event, getMainWindow);
    return profiles.clearStorage(requiredString(profileId, "profile id"));
  });
  ipcMain.handle("browser:create-profile", (event, profileId: unknown) => {
    assertTrustedSender(event, getMainWindow);
    return profiles.create(requiredString(profileId, "profile id"));
  });
  ipcMain.handle("browser:duplicate-profile", (event, sourceId: unknown, newId: unknown) => {
    assertTrustedSender(event, getMainWindow);
    return profiles.duplicate(
      requiredString(sourceId, "source profile id"),
      requiredString(newId, "new profile id"),
    );
  });
  ipcMain.handle("browser:delete-profile", (event, profileId: unknown) => {
    assertTrustedSender(event, getMainWindow);
    profiles.delete(requiredString(profileId, "profile id"));
  });
}

function registerNavigationIpc(
  manager: BrowserManager,
  getMainWindow: BrowserIpcOptions["getMainWindow"],
): void {
  ipcMain.handle("browser:back", (event, tabId: unknown) => {
    assertTrustedSender(event, getMainWindow);
    manager.page.goBack(requiredString(tabId, "tab id"));
  });
  ipcMain.handle("browser:forward", (event, tabId: unknown) => {
    assertTrustedSender(event, getMainWindow);
    manager.page.goForward(requiredString(tabId, "tab id"));
  });
  ipcMain.handle("browser:reload", (event, tabId: unknown) => {
    assertTrustedSender(event, getMainWindow);
    manager.page.reload(requiredString(tabId, "tab id"));
  });
  ipcMain.handle("browser:stop", (event, tabId: unknown) => {
    assertTrustedSender(event, getMainWindow);
    manager.page.stop(requiredString(tabId, "tab id"));
  });
  ipcMain.handle("browser:zoom-in", (event, tabId: unknown) => {
    assertTrustedSender(event, getMainWindow);
    manager.page.zoom(requiredString(tabId, "tab id"), "in");
  });
  ipcMain.handle("browser:zoom-out", (event, tabId: unknown) => {
    assertTrustedSender(event, getMainWindow);
    manager.page.zoom(requiredString(tabId, "tab id"), "out");
  });
  ipcMain.handle("browser:zoom-reset", (event, tabId: unknown) => {
    assertTrustedSender(event, getMainWindow);
    manager.page.zoom(requiredString(tabId, "tab id"), "reset");
  });
  ipcMain.handle("browser:find", (event, tabId: unknown, request: unknown) => {
    assertTrustedSender(event, getMainWindow);
    manager.page.find(requiredString(tabId, "tab id"), findRequestSchema.parse(request));
  });
  ipcMain.handle("browser:stop-find", (event, tabId: unknown, focusPage: unknown) => {
    assertTrustedSender(event, getMainWindow);
    manager.page.stopFind(requiredString(tabId, "tab id"), z.boolean().parse(focusPage));
  });
  ipcMain.handle("browser:set-guest-shortcuts", (event, bindings: unknown) => {
    assertTrustedSender(event, getMainWindow);
    manager.page.setGuestShortcutBindings(parseBrowserGuestShortcutBindings(bindings));
  });
  ipcMain.handle("browser:toggle-devtools", (event, tabId: unknown) => {
    assertTrustedSender(event, getMainWindow);
    return manager.toggleDevTools(requiredString(tabId, "tab id"));
  });
  ipcMain.handle("browser:set-responsive", (event, tabId: unknown, request: unknown) => {
    assertTrustedSender(event, getMainWindow);
    return manager.setResponsive(
      requiredString(tabId, "tab id"),
      parseBrowserResponsiveRequest(request),
    );
  });
}

function registerSiteIpc(
  manager: BrowserManager,
  getMainWindow: BrowserIpcOptions["getMainWindow"],
): void {
  ipcMain.handle("browser:get-site-info", (event, tabId: unknown) => {
    assertTrustedSender(event, getMainWindow);
    return manager.site.info(requiredString(tabId, "tab id"));
  });
  ipcMain.handle(
    "browser:set-site-permission",
    (event, tabId: unknown, origin: unknown, permission: unknown, decision: unknown) => {
      assertTrustedSender(event, getMainWindow);
      return manager.site.setPermission(
        requiredString(tabId, "tab id"),
        siteOriginSchema.parse(origin),
        sitePermissionSchema.parse(permission),
        siteDecisionSchema.parse(decision),
      );
    },
  );
  ipcMain.handle("browser:clear-site-data", (event, tabId: unknown, origin: unknown) => {
    assertTrustedSender(event, getMainWindow);
    return manager.site.clearData(requiredString(tabId, "tab id"), siteOriginSchema.parse(origin));
  });
  ipcMain.handle(
    "browser:set-agent-sharing",
    (event, tabId: unknown, origin: unknown, shared: unknown) => {
      assertTrustedSender(event, getMainWindow);
      return manager.site.setSharing(
        requiredString(tabId, "tab id"),
        siteOriginSchema.parse(origin),
        z.boolean().parse(shared),
      );
    },
  );
  ipcMain.handle(
    "browser:resolve-permission-request",
    (event, requestId: unknown, allowed: unknown) => {
      assertTrustedSender(event, getMainWindow);
      manager.site.resolvePermissionRequest(
        z.string().uuid().parse(requestId),
        z.boolean().parse(allowed),
      );
    },
  );
}

function registerInspectionIpc(
  manager: BrowserManager,
  getMainWindow: BrowserIpcOptions["getMainWindow"],
): void {
  ipcMain.handle("browser:get-console", (event) => {
    assertTrustedSender(event, getMainWindow);
    return manager.automationState().consoleEntries;
  });
  ipcMain.handle("browser:get-network", (event) => {
    assertTrustedSender(event, getMainWindow);
    return manager.automationState().networkEntries;
  });
  ipcMain.handle("browser:get-snapshot", (event, tabId: unknown) => {
    assertTrustedSender(event, getMainWindow);
    return manager.inspection.snapshot(requiredString(tabId, "tab id"));
  });
  ipcMain.handle("browser:screenshot", (event, tabId: unknown) => {
    assertTrustedSender(event, getMainWindow);
    return manager.inspection.screenshot(requiredString(tabId, "tab id"));
  });
  ipcMain.handle("browser:click", (event, tabId: unknown, x: unknown, y: unknown) => {
    assertTrustedSender(event, getMainWindow);
    return manager.click(
      requiredString(tabId, "tab id"),
      requiredNumber(x, "x"),
      requiredNumber(y, "y"),
    );
  });
  ipcMain.handle("browser:type", (event, tabId: unknown, text: unknown) => {
    assertTrustedSender(event, getMainWindow);
    return manager.inspection.typeText(
      requiredString(tabId, "tab id"),
      requiredString(text, "text"),
    );
  });
  ipcMain.handle("browser:keypress", (event, tabId: unknown, keyCode: unknown) => {
    assertTrustedSender(event, getMainWindow);
    return manager.inspection.keypress(
      requiredString(tabId, "tab id"),
      requiredString(keyCode, "key"),
    );
  });
  ipcMain.handle(
    "browser:select-element-context",
    async (event, tabId: unknown, anchorId: unknown) => {
      assertTrustedSender(event, getMainWindow);
      const context = await manager.inspection.selectElementContext(
        requiredString(tabId, "tab id"),
        requiredString(anchorId, "anchor id"),
      );
      // The pick was a click in the guest view, which kept keyboard focus: hand
      // it back so the comment composer can be typed into straight away.
      reclaimRendererFocus(getMainWindow());
      return context;
    },
  );
  ipcMain.handle("browser:remove-comment-badge", (event, tabId: unknown, anchorId: unknown) => {
    assertTrustedSender(event, getMainWindow);
    return manager.inspection.removeCommentBadge(
      requiredString(tabId, "tab id"),
      requiredString(anchorId, "anchor id"),
    );
  });
  ipcMain.handle("browser:clear-comment-badges", (event, tabId: unknown) => {
    assertTrustedSender(event, getMainWindow);
    return manager.inspection.clearCommentBadges(requiredString(tabId, "tab id"));
  });
}

function registerLibraryIpc(
  manager: BrowserManager,
  getMainWindow: BrowserIpcOptions["getMainWindow"],
): void {
  ipcMain.handle("browser:query-omnibox", (event, query: unknown, limit: unknown) => {
    assertTrustedSender(event, getMainWindow);
    return manager.library.query(libraryQuerySchema.parse(query), libraryLimitSchema.parse(limit));
  });
  ipcMain.handle("browser:get-bookmark", (event, url: unknown) => {
    assertTrustedSender(event, getMainWindow);
    return manager.library.getBookmark(libraryUrlSchema.parse(url));
  });
  ipcMain.handle("browser:remove-history", (event, id: unknown) => {
    assertTrustedSender(event, getMainWindow);
    return manager.library.removeHistoryEntry(historyIdSchema.parse(id));
  });
  ipcMain.handle("browser:clear-history", (event) => {
    assertTrustedSender(event, getMainWindow);
    return manager.library.clearHistory();
  });
  ipcMain.handle("browser:set-bookmark", (event, tabId: unknown, bookmarked: unknown) => {
    assertTrustedSender(event, getMainWindow);
    return manager.library.setBookmark(
      requiredString(tabId, "tab id"),
      z.boolean().parse(bookmarked),
    );
  });
}

export function registerBrowserIpc(options: BrowserIpcOptions): BrowserManager {
  const manager = new BrowserManager(options.getMainWindow);
  const profiles = new BrowserProfileController();
  registerTabIpc(manager, options);
  registerPopupIpc(manager, options.getMainWindow);
  registerProfileIpc(profiles, options.getMainWindow);
  registerNavigationIpc(manager, options.getMainWindow);
  registerSiteIpc(manager, options.getMainWindow);
  registerInspectionIpc(manager, options.getMainWindow);
  registerLibraryIpc(manager, options.getMainWindow);
  registerBrowserDownloadIpc(manager, options.getMainWindow);
  return manager;
}
