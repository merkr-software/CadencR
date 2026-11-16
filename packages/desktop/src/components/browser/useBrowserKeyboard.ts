import { useCallback, useEffect } from "react";

import { desktopBridge, type BrowserShortcut } from "@/lib/desktop-bridge";
import { useBrowserShortcutRelay } from "@/hooks/useBrowserShortcutRelay";
import { useScopedGlobalShortcutById } from "@/hooks/useShortcut";
import { useResolvedShortcut } from "@/lib/shortcuts/overrides";

import { showBrowserError } from "./browser-errors";
import type { BrowserWorkspaceModel } from "./useBrowserWorkspaceModel";

function useBrowserNavigationShortcuts(
  model: BrowserWorkspaceModel,
  hasTab: boolean,
  switchTab: (delta: number) => void,
  toggleDownloads: () => void,
): void {
  useScopedGlobalShortcutById(
    "browser-new-tab",
    (event) => {
      event.preventDefault();
      void model.newTab();
    },
    "browser",
  );
  useScopedGlobalShortcutById(
    "browser-close",
    (event) => {
      if (!hasTab) return;
      event.preventDefault();
      model.closeActiveTab();
    },
    "browser",
  );
  useScopedGlobalShortcutById(
    "browser-reopen-tab",
    (event) => {
      event.preventDefault();
      model.reopenLastClosedTab();
    },
    "browser",
  );
  useScopedGlobalShortcutById(
    "browser-prev-tab",
    (event) => {
      event.preventDefault();
      switchTab(-1);
    },
    "browser",
  );
  useScopedGlobalShortcutById(
    "browser-next-tab",
    (event) => {
      event.preventDefault();
      switchTab(1);
    },
    "browser",
  );
  useScopedGlobalShortcutById(
    "browser-downloads",
    (event) => {
      event.preventDefault();
      toggleDownloads();
    },
    "browser",
  );
  useScopedGlobalShortcutById(
    "browser-focus-url",
    (event) => {
      event.preventDefault();
      model.focusUrlBar();
    },
    "browser",
  );
}

function useBrowserPageShortcuts(
  model: BrowserWorkspaceModel,
  hasTab: boolean,
  addComment: () => void,
): void {
  const actionOptions = { enabled: hasTab };
  useScopedGlobalShortcutById(
    "browser-reload",
    (event) => {
      event.preventDefault();
      model.reload();
    },
    "browser",
    actionOptions,
  );
  useScopedGlobalShortcutById(
    "browser-find",
    (event) => {
      event.preventDefault();
      model.find.openFind();
    },
    "browser",
    actionOptions,
  );
  useScopedGlobalShortcutById(
    "zoom-in",
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      model.zoomIn();
    },
    "browser",
    actionOptions,
  );
  useScopedGlobalShortcutById(
    "zoom-out",
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      model.zoomOut();
    },
    "browser",
    actionOptions,
  );
  useScopedGlobalShortcutById(
    "zoom-reset",
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      model.zoomReset();
    },
    "browser",
    actionOptions,
  );
  useScopedGlobalShortcutById(
    "browser-add-comment",
    (event) => {
      event.preventDefault();
      addComment();
    },
    "browser",
    actionOptions,
  );
  useScopedGlobalShortcutById(
    "browser-devtools",
    (event) => {
      event.preventDefault();
      model.devTools();
    },
    "browser",
    actionOptions,
  );
  useScopedGlobalShortcutById(
    "browser-responsive",
    (event) => {
      event.preventDefault();
      model.responsive.toggle();
    },
    "browser",
    actionOptions,
  );
}

function useBrowserGuestShortcutRelay(
  model: BrowserWorkspaceModel,
  hasTab: boolean,
  switchTab: (delta: number) => void,
  addComment: () => void,
  toggleDownloads: () => void,
): void {
  useBrowserShortcutRelay((shortcut: BrowserShortcut) => {
    const actions: Partial<Record<BrowserShortcut, () => void>> = {
      "new-tab": () => void model.newTab(),
      "close-tab": () => model.closeActiveTab(),
      "reopen-tab": () => model.reopenLastClosedTab(),
      "prev-tab": () => switchTab(-1),
      "next-tab": () => switchTab(1),
      "focus-url": () => model.focusUrlBar(),
      find: () => {
        if (hasTab) model.find.openFind();
      },
      reload: () => model.reload(),
      "zoom-in": () => model.zoomIn(),
      "zoom-out": () => model.zoomOut(),
      "zoom-reset": () => model.zoomReset(),
      "add-comment": () => {
        if (hasTab) addComment();
      },
      downloads: toggleDownloads,
      responsive: () => {
        if (hasTab) model.responsive.toggle();
      },
      devtools: () => {
        if (hasTab) model.devTools();
      },
    };
    actions[shortcut]?.();
  });
}

function useBrowserGuestShortcutPublication(): void {
  const find = useResolvedShortcut("browser-find");
  const downloads = useResolvedShortcut("browser-downloads");
  const responsive = useResolvedShortcut("browser-responsive");
  const devtools = useResolvedShortcut("browser-devtools");
  const zoomReset = useResolvedShortcut("zoom-reset");
  const navigateBack = useResolvedShortcut("navigate-back");
  const navigateForward = useResolvedShortcut("navigate-forward");
  useEffect(() => {
    void desktopBridge
      .setBrowserGuestShortcuts({
        find: { keys: find.keys, altKeys: find.altKeys },
        downloads: { keys: downloads.keys, altKeys: downloads.altKeys },
        responsive: { keys: responsive.keys, altKeys: responsive.altKeys },
        devtools: { keys: devtools.keys, altKeys: devtools.altKeys },
        zoomReset: { keys: zoomReset.keys, altKeys: zoomReset.altKeys },
        navigateBack: { keys: navigateBack.keys, altKeys: navigateBack.altKeys },
        navigateForward: { keys: navigateForward.keys, altKeys: navigateForward.altKeys },
      })
      .catch((error: unknown) => {
        showBrowserError(error, "Could not configure Browser shortcuts");
      });
  }, [devtools, downloads, find, navigateBack, navigateForward, responsive, zoomReset]);
}

/**
 * Wire the browser-chrome chords. The scoped capture-phase hooks fire when the
 * Browser tab has renderer focus (toolbar, URL bar or empty area); the
 * `onBrowserShortcut` relay covers the case where the guest page itself holds
 * keyboard focus and the main process forwards the chord (see
 * `browser-tab-events.ts`). Both paths map to the same actions so a shortcut
 * works regardless of where focus currently sits.
 */
export function useBrowserKeyboard(
  model: BrowserWorkspaceModel,
  addComment: () => void,
  toggleDownloads: () => void,
): void {
  const hasTab = model.activeTab !== null;
  useBrowserGuestShortcutPublication();

  const switchTab = useCallback(
    (delta: number): void => {
      const { tabs } = model.state;
      if (tabs.length < 2) return;
      const index = tabs.findIndex((tab) => tab.id === model.activeTab?.id);
      if (index < 0) return;
      const next = tabs[(index + delta + tabs.length) % tabs.length];
      model.activateTab(next.id);
    },
    [model],
  );

  useBrowserNavigationShortcuts(model, hasTab, switchTab, toggleDownloads);
  useBrowserPageShortcuts(model, hasTab, addComment);
  useBrowserGuestShortcutRelay(model, hasTab, switchTab, addComment, toggleDownloads);
}
