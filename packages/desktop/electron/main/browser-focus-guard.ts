import type { BrowserWindow, WebContents } from "electron";
import { reclaimRendererFocus } from "./browser-manager-utils";

// How long after an agent browser action we keep reclaiming renderer focus.
// sendInputEvent-driven focus (click/type/keypress) lands a tick *after* the
// tool call resolves, so the guard has to outlive the call by a short margin.
const RECLAIM_TAIL_MS = 250;

/**
 * Stops a guest page from stealing the renderer's focus while the agent drives
 * the browser. Acting on a guest element — a synthetic click, `el.focus()` in a
 * fill, typed input — pulls native focus onto its WebContentsView and blurs
 * whatever the user was doing in the renderer (most visibly, the agent prompt).
 *
 * `run` brackets an agent (MCP) tool call: if the renderer held focus going in,
 * any guest `focus` event that fires during the call (or just after it) bounces
 * focus straight back to the main window. User-driven browser focus is left
 * alone — the guard only reclaims while an agent tool is in flight.
 */
export class BrowserFocusGuard {
  // >0 while an agent tool that started with the renderer focused is settling.
  private settling = 0;

  constructor(private readonly getMainWindow: () => BrowserWindow | null) {}

  /** Wire a guest webContents so it can't keep focus mid-agent-action. */
  watch(contents: WebContents): void {
    contents.on("focus", () => {
      if (this.settling > 0) this.reclaim();
    });
  }

  /** Run an agent browser tool, shielding renderer focus around it. */
  async run<T>(action: () => Promise<T>): Promise<T> {
    const shield = this.mainFocused();
    if (shield) this.settling += 1;
    try {
      return await action();
    } finally {
      if (shield) {
        this.reclaim();
        setTimeout(() => {
          this.settling = Math.max(0, this.settling - 1);
        }, RECLAIM_TAIL_MS);
      }
    }
  }

  private mainFocused(): boolean {
    const win = this.getMainWindow();
    return !!win && !win.isDestroyed() && win.webContents.isFocused();
  }

  private reclaim(): void {
    reclaimRendererFocus(this.getMainWindow());
  }
}
