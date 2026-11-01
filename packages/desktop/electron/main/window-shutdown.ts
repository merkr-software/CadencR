import { BrowserWindow } from "electron";

export function closeAllWindowsForQuit(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.close();
  }
}
