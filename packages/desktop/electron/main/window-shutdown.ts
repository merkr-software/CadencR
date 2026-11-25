import { translateUi as t } from "../../src/shared/ui-i18n";
import { BrowserWindow, dialog } from "electron";

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

export function reportIgnoredQuitIntent(message: string): void {
  dialog.showErrorBox(
    t("system.shutdown.resumeWarning", "Cadencr may resume background work on its next start"),
    message,
  );
}

export function reportShutdownFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Could not complete shutdown safely: ${message}`);
  dialog.showErrorBox(t("system.shutdown.failed", "Could not close Cadencr"), message);
}

export function reportResumeFailure(error: unknown): void {
  dialog.showErrorBox(
    t("system.shutdown.agentsWarning", "Cadencr may not resume your agents after a restart"),
    error instanceof Error ? error.message : String(error),
  );
}
