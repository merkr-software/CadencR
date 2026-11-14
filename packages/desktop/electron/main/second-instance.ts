import { app, type BrowserWindow } from "electron";

export interface SecondInstanceOptions {
  getMainWindow: () => BrowserWindow | null;
  getSplashWindow: () => BrowserWindow | null;
  /**
   * No window at all (macOS keeps the app running once its window is closed):
   * open one, as the Dock icon does, so the request shows. A no-op before the
   * app has started, when the startup in progress opens it.
   */
  reopenWindow: () => void;
  /** Acts on a `cadencr` command request in `argv`; true when there was one. */
  handleCliArgv: (argv: readonly string[]) => Promise<boolean>;
}

/** From a terminal the app is in the background: a CLI request brings it forward. */
export function focusForCliRequest(requested: boolean): void {
  if (requested && process.platform === "darwin") app.focus({ steal: true });
}

/**
 * Another launch (the dock, a launcher, the `cadencr` command) reached this
 * instance through the single-instance lock: show the app, then act on what the
 * command asked for.
 */
export function registerSecondInstance({
  getMainWindow,
  getSplashWindow,
  reopenWindow,
  handleCliArgv,
}: SecondInstanceOptions): void {
  app.on("second-instance", (_event, argv) => {
    const mainWindow = getMainWindow();
    const splash = getSplashWindow();
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (splash) {
      splash.focus();
    } else {
      reopenWindow();
    }
    void handleCliArgv(argv).then(focusForCliRequest);
  });
}
