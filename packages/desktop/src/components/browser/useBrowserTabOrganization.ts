import { translateUi, type UiTranslator } from "@/lib/i18n/ui";
import { useCallback, useMemo, useRef, useState } from "react";

import { desktopBridge } from "@/lib/desktop-bridge";
import { showBrowserError } from "./browser-errors";

const ACTIONS = {
  duplicate: {
    pending: (t: UiTranslator) =>
      t("workspace.tools.browserTabAction.duplicatePending", "Duplicating tab"),
    failure: () =>
      translateUi("workspace.tools.browserTabAction.duplicateFailed", "Could not duplicate tab"),
  },
  pin: {
    pending: (t: UiTranslator) => t("workspace.tools.browserTabAction.pinPending", "Pinning tab"),
    failure: () => translateUi("workspace.tools.browserTabAction.pinFailed", "Could not pin tab"),
  },
  unpin: {
    pending: (t: UiTranslator) =>
      t("workspace.tools.browserTabAction.unpinPending", "Unpinning tab"),
    failure: () =>
      translateUi("workspace.tools.browserTabAction.unpinFailed", "Could not unpin tab"),
  },
  move: {
    pending: (t: UiTranslator) => t("workspace.tools.browserTabAction.movePending", "Moving tab"),
    failure: () => translateUi("workspace.tools.browserTabAction.moveFailed", "Could not move tab"),
  },
  closeOthers: {
    pending: (t: UiTranslator) =>
      t("workspace.tools.browserTabAction.closeOthersPending", "Closing other tabs"),
    failure: () =>
      translateUi(
        "workspace.tools.browserTabAction.closeOthersFailed",
        "Could not close other tabs",
      ),
  },
  reopen: {
    pending: (t: UiTranslator) =>
      t("workspace.tools.browserTabAction.reopenPending", "Reopening tab"),
    failure: () =>
      translateUi("workspace.tools.browserTabAction.reopenFailed", "Could not reopen tab"),
  },
} as const;

type BrowserTabAction = keyof typeof ACTIONS;

export function browserTabActionLabel(action: BrowserTabAction, t: UiTranslator): string {
  return ACTIONS[action].pending(t);
}

export interface BrowserTabOrganization {
  pendingAction: BrowserTabAction | null;
  duplicateTab: (tabId: string) => void;
  setTabPinned: (tabId: string, pinned: boolean) => void;
  reorderTab: (tabId: string, targetIndex: number) => void;
  closeOtherTabs: (tabId: string) => void;
  reopenLastClosedTab: () => void;
}

export function useBrowserTabOrganization(scopeId: number): BrowserTabOrganization {
  const [pendingAction, setPendingAction] = useState<BrowserTabAction | null>(null);
  const pendingRef = useRef(false);
  const run = useCallback((action: BrowserTabAction, operation: () => Promise<unknown>): void => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPendingAction(action);
    void operation()
      .catch((error: unknown) => showBrowserError(error, ACTIONS[action].failure()))
      .finally(() => {
        pendingRef.current = false;
        setPendingAction(null);
      });
  }, []);
  const duplicateTab = useCallback(
    (tabId: string) => run("duplicate", () => desktopBridge.duplicateBrowserTab(tabId)),
    [run],
  );
  const setTabPinned = useCallback(
    (tabId: string, pinned: boolean) =>
      run(pinned ? "pin" : "unpin", () => desktopBridge.setBrowserTabPinned(tabId, pinned)),
    [run],
  );
  const reorderTab = useCallback(
    (tabId: string, targetIndex: number) =>
      run("move", () => desktopBridge.reorderBrowserTab(tabId, targetIndex)),
    [run],
  );
  const closeOtherTabs = useCallback(
    (tabId: string) => run("closeOthers", () => desktopBridge.closeOtherBrowserTabs(tabId)),
    [run],
  );
  const reopenLastClosedTab = useCallback(
    () => run("reopen", () => desktopBridge.reopenLastClosedBrowserTab(scopeId)),
    [run, scopeId],
  );
  return useMemo(
    () => ({
      pendingAction,
      duplicateTab,
      setTabPinned,
      reorderTab,
      closeOtherTabs,
      reopenLastClosedTab,
    }),
    [closeOtherTabs, duplicateTab, pendingAction, reopenLastClosedTab, reorderTab, setTabPinned],
  );
}
