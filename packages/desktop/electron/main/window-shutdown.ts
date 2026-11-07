import { BrowserWindow } from "electron";

/**
 * Close every window for quit. A window whose renderer cannot answer (crashed
 * or hung) is destroyed: `close()` would wait on it forever.
 */
export function closeAllWindowsForQuit(cannotAnswer: (win: BrowserWindow) => boolean): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    if (cannotAnswer(win)) win.destroy();
    else win.close();
  }
}
