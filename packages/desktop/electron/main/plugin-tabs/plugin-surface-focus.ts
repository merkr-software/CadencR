import type { BrowserWindow } from "electron";

/** On macOS WebContents focus events omit switches between native windows. */
export class PluginSurfaceWindowFocus {
  private window: BrowserWindow | null = null;
  private readonly focused = (): void => this.changed(true);
  private readonly blurred = (): void => this.changed(false);

  constructor(private readonly changed: (active: boolean) => void) {}

  watch(window: BrowserWindow | null): void {
    if (window === this.window) return;
    this.dispose();
    this.window = window;
    window?.on?.("focus", this.focused);
    window?.on?.("blur", this.blurred);
  }

  dispose(): void {
    this.window?.removeListener?.("focus", this.focused);
    this.window?.removeListener?.("blur", this.blurred);
    this.window = null;
  }
}
