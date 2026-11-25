import {
  clipboard,
  Menu,
  type BrowserWindow,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";

import { translateUi } from "../../src/shared/ui-i18n";
import { editMenuLabels } from "./edit-menu-labels";
import { normalizeBrowserOpenUrl } from "./browser-policy";

interface BrowserContextMenuActions {
  openLinkInNewTab(url: string): void;
  inspectElement(x: number, y: number): void;
  reportError(error: unknown): void;
}

function guardedAction(
  contents: WebContents,
  reportError: (error: unknown) => void,
  action: () => void,
): () => void {
  return () => {
    try {
      if (contents.isDestroyed())
        throw new Error(
          translateUi("workspace.browser.tabGone", "Browser tab is no longer available."),
        );
      action();
    } catch (error) {
      reportError(error);
    }
  };
}

function safeBrowserLink(rawUrl: string): string | null {
  if (!rawUrl) return null;
  try {
    return normalizeBrowserOpenUrl(rawUrl);
  } catch {
    return null;
  }
}

/** Build Chromium-style guest actions whose callbacks always target the originating page. */
export function buildBrowserContextMenuTemplate(
  contents: WebContents,
  params: ContextMenuParams,
  actions: BrowserContextMenuActions,
): MenuItemConstructorOptions[] {
  const run = (action: () => void): (() => void) =>
    guardedAction(contents, actions.reportError, action);
  const items: MenuItemConstructorOptions[] = [
    {
      label: translateUi("workspace.browser.menu.back", "Back"),
      enabled: contents.canGoBack(),
      click: run(() => contents.goBack()),
    },
    {
      label: translateUi("workspace.browser.menu.forward", "Forward"),
      enabled: contents.canGoForward(),
      click: run(() => contents.goForward()),
    },
    {
      label: translateUi("workspace.browser.menu.reload", "Reload"),
      click: run(() => contents.reload()),
    },
    { type: "separator" },
  ];
  const linkUrl = safeBrowserLink(params.linkURL);
  if (linkUrl) {
    items.push(
      {
        label: translateUi("workspace.browser.menu.openLinkTab", "Open Link in New Tab"),
        click: run(() => actions.openLinkInNewTab(linkUrl)),
      },
      {
        label: translateUi("native.context.copyLinkAddress", "Copy Link Address"),
        click: run(() => clipboard.writeText(linkUrl)),
      },
      { type: "separator" },
    );
  }
  if (params.misspelledWord) {
    for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
      items.push({
        label: suggestion,
        click: run(() => contents.replaceMisspelling(suggestion)),
      });
    }
    if (params.dictionarySuggestions.length === 0) {
      items.push({
        label: translateUi("native.context.noSuggestions", "No suggestions"),
        enabled: false,
      });
    }
    items.push({ type: "separator" });
  }
  items.push(
    {
      label: editMenuLabels.undo(),
      enabled: params.editFlags.canUndo,
      click: run(() => contents.undo()),
    },
    {
      label: editMenuLabels.redo(),
      enabled: params.editFlags.canRedo,
      click: run(() => contents.redo()),
    },
    { type: "separator" },
    {
      label: editMenuLabels.cut(),
      enabled: params.editFlags.canCut,
      click: run(() => contents.cut()),
    },
    {
      label: editMenuLabels.copy(),
      enabled: params.editFlags.canCopy,
      click: run(() => contents.copy()),
    },
    {
      label: editMenuLabels.paste(),
      enabled: params.editFlags.canPaste,
      click: run(() => contents.paste()),
    },
    {
      label: editMenuLabels.selectAll(),
      enabled: params.editFlags.canSelectAll,
      click: run(() => contents.selectAll()),
    },
    { type: "separator" },
    {
      label: translateUi("workspace.browser.menu.inspect", "Inspect Element"),
      click: run(() => actions.inspectElement(params.x, params.y)),
    },
  );
  return items;
}

export function installBrowserContextMenu(
  contents: WebContents,
  getWindow: () => BrowserWindow | null,
  actions: BrowserContextMenuActions,
): void {
  contents.on("context-menu", (event, params) => {
    event.preventDefault();
    try {
      if (contents.isDestroyed())
        throw new Error(
          translateUi("workspace.browser.tabGone", "Browser tab is no longer available."),
        );
      const window = getWindow();
      if (!window || window.isDestroyed())
        throw new Error(
          translateUi("workspace.browser.windowGone", "Browser window is not available."),
        );
      Menu.buildFromTemplate(buildBrowserContextMenuTemplate(contents, params, actions)).popup({
        window,
      });
    } catch (error) {
      actions.reportError(error);
    }
  });
}
