import {
  app,
  BrowserWindow,
  Menu,
  type BaseWindow,
  type WebContents,
  type MenuItem,
  type MenuItemConstructorOptions,
} from "electron";

interface EditCommand {
  label: string;
  run: (webContents: WebContents) => void;
}

const NON_MAC_EDIT_COMMANDS: readonly EditCommand[] = [
  { label: "Undo", run: (webContents) => webContents.undo() },
  { label: "Redo", run: (webContents) => webContents.redo() },
  { label: "Cut", run: (webContents) => webContents.cut() },
  { label: "Copy", run: (webContents) => webContents.copy() },
  { label: "Paste", run: (webContents) => webContents.paste() },
  { label: "Select All", run: (webContents) => webContents.selectAll() },
];

export function installApplicationMenu(onQuit: () => void): void {
  const appMenu: MenuItemConstructorOptions =
    process.platform === "darwin"
      ? {
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { label: `Quit ${app.name}`, accelerator: "CmdOrCtrl+Q", click: onQuit },
          ],
        }
      : { label: "File", submenu: [{ label: "Quit", accelerator: "CmdOrCtrl+Q", click: onQuit }] };

  const devViewSubmenu = app.isPackaged
    ? []
    : ([
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
      ] satisfies MenuItemConstructorOptions[]);

  const template: MenuItemConstructorOptions[] = [
    appMenu,
    buildEditMenu(),
    ...(devViewSubmenu.length > 0 ? [{ label: "View", submenu: devViewSubmenu }] : []),
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "togglefullscreen" }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function buildEditMenu(): MenuItemConstructorOptions {
  if (process.platform === "darwin") {
    return {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    };
  }

  return {
    label: "Edit",
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
    label: command.label,
    click: (_item: MenuItem, focusedWindow: BaseWindow | undefined): void => {
      const webContents = focusedWindow
        ? BrowserWindow.fromId(focusedWindow.id)?.webContents
        : null;
      if (webContents) command.run(webContents);
    },
  };
}
