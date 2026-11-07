interface HealthWebContents {
  isDestroyed: () => boolean;
  isCrashed: () => boolean;
  on(event: "render-process-gone", listener: () => void): unknown;
}

export interface HealthWindow {
  isDestroyed: () => boolean;
  // One overload per event: Electron types `on` as per-event overloads, which a
  // single union signature cannot match.
  on(event: "unresponsive", listener: () => void): unknown;
  on(event: "responsive", listener: () => void): unknown;
  close: () => void;
  destroy: () => void;
  webContents: HealthWebContents;
}

/**
 * Whether the main window's renderer can still answer: present, not crashed,
 * and not hung (Electron's `unresponsive`). Main stops waiting on a renderer
 * that cannot; a quit must never depend on it.
 */
export class RendererHealth {
  private hung = false;

  constructor(private readonly onLost: () => void) {}

  watch(win: HealthWindow): void {
    this.hung = false;
    win.on("unresponsive", () => {
      this.hung = true;
      this.onLost();
    });
    win.on("responsive", () => {
      this.hung = false;
    });
    win.webContents.on("render-process-gone", () => this.onLost());
  }

  canAnswer(win: HealthWindow | null): boolean {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false;
    return !this.hung && !win.webContents.isCrashed();
  }

  /** A hung renderer never lets `close()` finish, so it is torn down instead. */
  closeNow(win: HealthWindow | null): void {
    if (!win || win.isDestroyed()) return;
    if (this.canAnswer(win)) win.close();
    else win.destroy();
  }
}
