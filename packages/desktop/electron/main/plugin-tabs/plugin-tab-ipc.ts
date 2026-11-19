import { ipcMain, nativeTheme, session, type BrowserWindow } from "electron";
import { z } from "zod";

import { MAX_PLUGIN_TAB_THEME_CSS_LENGTH } from "../../../src/shared/plugin-tab-host";
import { optionalNumber, parseBounds } from "../browser-arg-validation";
import { assertTrustedSender } from "../ipc";
import { getRuntimeConfig } from "../runtime-config";
import { createPluginTabAssetHandler } from "./plugin-tab-asset-handler";
import { createPluginTabGuest } from "./plugin-tab-guest";
import { GUEST_THEME_CSS_CHANNEL, parseInstanceId, parsePluginId } from "./plugin-tab-ids";
import { PluginTabManager } from "./plugin-tab-manager";
import { PluginTabSessions } from "./plugin-tab-session";
import { parseAppShortcutBindings, parseTabShortcuts } from "./plugin-tab-shortcuts";

// Neutral fallbacks until the renderer pushes its first theme.
const DARK_BACKGROUND = "#0f1115";
const LIGHT_BACKGROUND = "#ffffff";

// Colors Electron's `setBackgroundColor` accepts; anything else is refused at
// the boundary rather than handed to native code.
const backgroundSchema = z
  .string()
  .max(64)
  .regex(/^(#[0-9a-fA-F]{3,8}|(rgba?|hsla?)\([0-9.,%\s]+\)|[a-zA-Z]{3,32})$/);
const themeSchema = z
  .object({
    css: z.string().max(MAX_PLUGIN_TAB_THEME_CSS_LENGTH),
    background: backgroundSchema,
  })
  .strict();

interface PluginTabIpcOptions {
  getMainWindow: () => BrowserWindow | null;
  /** Built guest preload (`out/preload/plugin-tab.js`). */
  preloadPath: string;
}

export function createPluginTabManager(options: PluginTabIpcOptions): PluginTabManager {
  const sessions = new PluginTabSessions({
    fromPartition: (partition) => session.fromPartition(partition),
    createAssetHandler: (pluginId) =>
      createPluginTabAssetHandler(pluginId, {
        getConfig: getRuntimeConfig,
        fetch: (input, init) => fetch(input, init),
      }),
  });
  return new PluginTabManager({
    getMainWindow: options.getMainWindow,
    defaultBackground: () => (nativeTheme.shouldUseDarkColors ? DARK_BACKGROUND : LIGHT_BACKGROUND),
    createGuest: (guestOptions) =>
      createPluginTabGuest(guestOptions, {
        preloadPath: options.preloadPath,
        prepareSession: (pluginId) => sessions.prepare(pluginId),
      }),
  });
}

function registerRendererIpc(
  manager: PluginTabManager,
  getMainWindow: PluginTabIpcOptions["getMainWindow"],
): void {
  ipcMain.handle(
    "plugin-tab:open",
    (event, instanceId: unknown, pluginId: unknown, surface: unknown) => {
      assertTrustedSender(event, getMainWindow);
      manager.open(
        parseInstanceId(instanceId),
        parsePluginId(pluginId),
        z
          .object({ kind: z.enum(["tab", "editor"]) })
          .strict()
          .optional()
          .parse(surface),
      );
    },
  );
  ipcMain.handle(
    "plugin-tab:set-bounds",
    (event, instanceId: unknown, bounds: unknown, zoomFactor: unknown) => {
      assertTrustedSender(event, getMainWindow);
      manager.setBounds(
        parseInstanceId(instanceId),
        parseBounds(bounds),
        optionalNumber(zoomFactor),
      );
    },
  );
  ipcMain.handle("plugin-tab:set-visible", (event, instanceId: unknown, visible: unknown) => {
    assertTrustedSender(event, getMainWindow);
    manager.setVisible(parseInstanceId(instanceId), z.boolean().parse(visible));
  });
  ipcMain.handle("plugin-tab:reload", (event, instanceId: unknown) => {
    assertTrustedSender(event, getMainWindow);
    manager.reload(parseInstanceId(instanceId));
  });
  ipcMain.handle("plugin-tab:close", (event, instanceId: unknown) => {
    assertTrustedSender(event, getMainWindow);
    manager.close(parseInstanceId(instanceId));
  });
  ipcMain.handle("plugin-tab:open-devtools", (event, instanceId: unknown) => {
    assertTrustedSender(event, getMainWindow);
    manager.openDevTools(parseInstanceId(instanceId));
  });
  ipcMain.handle("plugin-tab:focus", (event, instanceId: unknown) => {
    assertTrustedSender(event, getMainWindow);
    manager.focus(parseInstanceId(instanceId));
  });
  ipcMain.handle("plugin-tab:set-theme", (event, theme: unknown) => {
    assertTrustedSender(event, getMainWindow);
    manager.setTheme(themeSchema.parse(theme));
  });
  ipcMain.handle("plugin-tab:set-app-shortcuts", (event, bindings: unknown) => {
    assertTrustedSender(event, getMainWindow);
    manager.setAppShortcuts(parseAppShortcutBindings(bindings));
  });
  ipcMain.handle(
    "plugin-tab:set-tab-shortcuts",
    (event, instanceId: unknown, shortcuts: unknown) => {
      assertTrustedSender(event, getMainWindow);
      manager.setTabShortcuts(parseInstanceId(instanceId), parseTabShortcuts(shortcuts));
    },
  );
}

/**
 * Only live guest webContents get theme CSS; any other sender (including the
 * main window) gets an empty string — a sync IPC must always set
 * `returnValue`, or the sender blocks forever.
 */
export function answerGuestThemeCss(
  manager: Pick<PluginTabManager, "isGuestWebContents" | "themeCss">,
  event: Pick<Electron.IpcMainEvent, "sender" | "returnValue">,
): void {
  event.returnValue = manager.isGuestWebContents(event.sender.id) ? manager.themeCss() : "";
}

/** Wire the custom-tab host: renderer IPC plus the guest preload's theme query. */
export function registerPluginTabIpc(options: PluginTabIpcOptions): PluginTabManager {
  const manager = createPluginTabManager(options);
  registerRendererIpc(manager, options.getMainWindow);
  ipcMain.on(GUEST_THEME_CSS_CHANNEL, (event) => answerGuestThemeCss(manager, event));
  return manager;
}
