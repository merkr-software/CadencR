import { executeBrowserScript } from "./browser-document-security";
import {
  addCommentBadgeScript,
  clearCommentBadgesScript,
  removeCommentBadgeScript,
} from "./browser-comment-overlay-script";
import { captureElementContext } from "./browser-dom";
import { waitForLoad } from "./browser-interactions";
import { tabDiagnostics } from "./browser-manager-utils";
import { browserScreenshotClipScale } from "./browser-screenshot";
import type { ManagedTab } from "./browser-tab-events";
import type { BrowserElementContext } from "./browser-types";

// Anchors whose badge we pinned, per tab. Any page can print the badge-click
// sentinel, so only a click on one of these is trusted to pull keyboard focus.
const pinnedBadges = new WeakMap<ManagedTab, Set<string>>();

export function isPinnedCommentBadge(tab: ManagedTab, anchorId: string): boolean {
  return pinnedBadges.get(tab)?.has(anchorId) ?? false;
}

type SelectionAttempt =
  | { kind: "selected"; context: BrowserElementContext }
  | { kind: "navigated" };

function captureUntilNavigation(
  tab: ManagedTab,
  anchorId: string | null,
  authorize: () => void,
): Promise<SelectionAttempt> {
  const contents = tab.webContents;
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      contents.off("did-start-navigation", onNavigation);
      contents.off("destroyed", onDestroyed);
    };
    const finish = (attempt: SelectionAttempt): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(attempt);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onNavigation = (details: Electron.WebContentsDidStartNavigationEventParams): void => {
      if (details.isMainFrame && !details.isSameDocument) finish({ kind: "navigated" });
    };
    const onDestroyed = (): void => fail(new Error("Browser tab closed during element selection."));

    contents.on("did-start-navigation", onNavigation);
    contents.once("destroyed", onDestroyed);
    void captureElementContext(
      contents,
      {
        tabId: tab.metadata.id,
        url: tab.metadata.url,
        title: tab.metadata.title,
        capturedAt: new Date().toISOString(),
      },
      tabDiagnostics(tab.consoleEntries, tab.networkEntries),
      anchorId,
      () => browserScreenshotClipScale(tab),
      authorize,
    ).then((context) => finish({ kind: "selected", context }), fail);
  });
}

export async function selectElementContext(
  tab: ManagedTab,
  anchorId?: string,
  authorize: () => void = () => undefined,
): Promise<BrowserElementContext> {
  const resolvedAnchorId = anchorId ?? null;
  while (true) {
    authorize();
    const attempt = await captureUntilNavigation(tab, resolvedAnchorId, authorize);
    if (attempt.kind === "navigated") {
      authorize();
      // A navigation destroys the page world that owns the picker promise.
      // Wait for the replacement document, then arm the picker there while the
      // renderer keeps showing the existing visible "picking" state.
      await waitForLoad(tab.webContents);
      authorize();
      continue;
    }
    // Pin a numbered badge to the element the user just picked. The agent/MCP
    // path passes no anchor and gets context without a badge.
    if (anchorId) {
      await executeBrowserScript(tab.webContents, addCommentBadgeScript(anchorId));
      const anchors = pinnedBadges.get(tab) ?? new Set<string>();
      pinnedBadges.set(tab, anchors.add(anchorId));
    }
    return attempt.context;
  }
}

export async function removeCommentBadge(tab: ManagedTab, anchorId: string): Promise<void> {
  pinnedBadges.get(tab)?.delete(anchorId);
  await executeBrowserScript(tab.webContents, removeCommentBadgeScript(anchorId));
}

export async function clearCommentBadges(tab: ManagedTab): Promise<void> {
  pinnedBadges.delete(tab);
  await executeBrowserScript(tab.webContents, clearCommentBadgesScript());
}
