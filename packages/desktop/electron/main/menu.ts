import { editMenuLabels } from "./edit-menu-labels";
import { translateUi, uiI18n } from "../../src/shared/ui-i18n";
import {
  app,
  BrowserWindow,
  Menu,
  type BaseWindow,
  type WebContents,
  type MenuItem,
  type MenuItemConstructorOptions,
  webContents as allWebContents,
} from "electron";

interface EditCommand {
  label: () => string;
  run: (webContents: WebContents) => void;
}

const NON_MAC_EDIT_COMMANDS: readonly EditCommand[] = [
  {
    label: editMenuLabels.undo,
    run: (webContents) => webContents.undo(),
  },
  {
    label: editMenuLabels.redo,
    run: (webContents) => webContents.redo(),
  },
  { label: editMenuLabels.cut, run: (webContents) => webContents.cut() },
  {
    label: editMenuLabels.copy,
    run: (webContents) => webContents.copy(),
  },
  {
    label: editMenuLabels.paste,
    run: (webContents) => webContents.paste(),
  },
  {
    label: editMenuLabels.selectAll,
    run: (webContents) => webContents.selectAll(),
  },
];

export function startApplicationMenu(onQuit: () => void): () => void {
  const refresh = () => installApplicationMenu(onQuit);
  refresh();
  uiI18n.on("languageChanged", refresh);
  return () => uiI18n.off("languageChanged", refresh);
}

export function installApplicationMenu(onQuit: () => void): void {
  const appMenu: MenuItemConstructorOptions =
    process.platform === "darwin"
      ? {
          label: app.name,
          submenu: [
            {
              role: "about",
              label: translateUi("native.menu.aboutApp", "About {{appName}}", {
                appName: app.name,
              }),
            },
            { type: "separator" },
            {
              role: "hide",
              label: translateUi("native.menu.hideApp", "Hide {{appName}}", { appName: app.name }),
            },
            { role: "hideOthers", label: translateUi("native.menu.hideOthers", "Hide Others") },
            { role: "unhide", label: translateUi("native.menu.showAll", "Show All") },
            { type: "separator" },
            {
              label: translateUi("native.menu.quitApp", "Quit {{appName}}", { appName: app.name }),
              accelerator: "CmdOrCtrl+Q",
              click: onQuit,
            },
          ],
        }
      : {
          label: translateUi("native.menu.file", "File"),
          submenu: [
            {
              label: translateUi("native.menu.quit", "Quit"),
              accelerator: "CmdOrCtrl+Q",
              click: onQuit,
            },
          ],
        };

  const devViewSubmenu = app.isPackaged
    ? []
    : ([
        { role: "reload", label: translateUi("native.menu.reload", "Reload") },
        { role: "forceReload", label: translateUi("native.menu.forceReload", "Force Reload") },
        {
          role: "toggleDevTools",
          label: translateUi("native.menu.toggleDeveloperTools", "Toggle Developer Tools"),
        },
      ] satisfies MenuItemConstructorOptions[]);
  const windowSubmenu: MenuItemConstructorOptions[] = [
    { role: "minimize", label: translateUi("native.menu.minimize", "Minimize") },
    // `zoom` is the macOS title-bar zoom; it does nothing elsewhere.
    ...(process.platform === "darwin"
      ? ([{ role: "zoom", label: translateUi("native.menu.zoom", "Zoom") }] as const)
      : []),
    {
      role: "togglefullscreen",
      label: translateUi("native.menu.toggleFullScreen", "Toggle Full Screen"),
    },
  ];

  const template: MenuItemConstructorOptions[] = [
    appMenu,
    buildEditMenu(),
    ...(devViewSubmenu.length > 0
      ? [{ label: translateUi("native.menu.view", "View"), submenu: devViewSubmenu }]
      : []),
    {
      label: translateUi("native.menu.window", "Window"),
      submenu: windowSubmenu,
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function buildEditMenu(): MenuItemConstructorOptions {
  if (process.platform === "darwin") {
    return {
      label: translateUi("native.menu.edit", "Edit"),
      submenu: [
        { role: "undo", label: editMenuLabels.undo() },
        { role: "redo", label: editMenuLabels.redo() },
        { type: "separator" },
        { role: "cut", label: editMenuLabels.cut() },
        { role: "copy", label: editMenuLabels.copy() },
        { role: "paste", label: editMenuLabels.paste() },
        { role: "selectAll", label: editMenuLabels.selectAll() },
      ],
    };
  }

  return {
    label: translateUi("native.menu.edit", "Edit"),
    submenu: [
      editMenuItem(NON_MAC_EDIT_COMMANDS[0]),
      editMenuItem(NON_MAC_EDIT_COMMANDS[1]),
      { type: "separator" },
      ...NON_MAC_EDIT_COMMANDS.slice(2).map(editMenuItem),
    ],
  };
}

function editMenuItem(command: EditCommand): MenuItemConstructorOptions {
  return {
    label: command.label(),
    click: (_item: MenuItem, focusedWindow: BaseWindow | undefined): void => {
      const target = editTarget(focusedWindow);
      if (target) command.run(target);
    },
  };
}

// Embedded browser and custom tabs are their own WebContentsViews, so the
// window's main webContents is the wrong target when one of them has focus.
// The native macOS roles already follow focus this way.
function editTarget(focusedWindow: BaseWindow | undefined): WebContents | null {
  const focused = allWebContents.getFocusedWebContents();
  if (focused) return focused;
  return focusedWindow ? (BrowserWindow.fromId(focusedWindow.id)?.webContents ?? null) : null;
}
