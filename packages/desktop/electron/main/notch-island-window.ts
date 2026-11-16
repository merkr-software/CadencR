import path from "node:path";
import { BrowserWindow, screen } from "electron";
import {
  isNotchPreview,
  type NotchGeometry,
  type NotchHotRect,
  type NotchNotification,
  type NotchPrefs,
  type NotchReadyPayload,
  type NotchSnapshot,
} from "../../src/shared/notch";
import { preventAppActivation } from "./mac-window";
import type { NotchPlacement } from "./notch-geometry";
import { rendererLoadTarget, secureWebContents } from "./renderer-window-security";
import { sendToWindow } from "./safe-send";

const WINDOW_WIDTH = 720;
const WINDOW_HEIGHT = 620;
const POINTER_POLL_MS = 50;
const POINTER_IDLE_POLL_MS = 200;
const POINTER_NEAR_PX = 160;
const MAX_PENDING_NOTIFICATIONS = 4;

/** One island per display, with its own geometry, readiness, and pointer state. */
export class NotchIslandWindow {
  readonly window: BrowserWindow;
  private ready = false;
  private pendingNotifications: NotchNotification[] = [];
  private bounds: Electron.Rectangle;
  private hotRect: NotchHotRect | null = null;
  private hovering = false;
  /** After a click-through collapse, wait for the pointer to leave before re-expanding. */
  private suppressUntilLeave = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private snapshot: NotchSnapshot;
  private prefs: NotchPrefs;
  private snoozedUntil: number | null;

  constructor(
    private placement: NotchPlacement,
    state: { snapshot: NotchSnapshot; prefs: NotchPrefs; snoozedUntil: number | null },
  ) {
    this.snapshot = state.snapshot;
    this.prefs = state.prefs;
    this.snoozedUntil = state.snoozedUntil;
    this.bounds = windowBounds(placement);
    this.window = createWindow(this.bounds);
    this.window.on("closed", () => this.stopPolling());
    this.startPolling();
  }

  updatePlacement(placement: NotchPlacement): void {
    const next = windowBounds(placement);
    if (next.x !== this.bounds.x || next.y !== this.bounds.y) this.collapse();
    this.placement = placement;
    this.bounds = next;
    this.window.setBounds(next);
    if (this.ready) sendToWindow(this.window, "notch:geometry", this.geometry());
  }

  updatePrefs(prefs: NotchPrefs): void {
    this.prefs = prefs;
    if (this.ready) sendToWindow(this.window, "notch:prefs", prefs);
  }

  pushSnapshot(snapshot: NotchSnapshot): void {
    this.snapshot = snapshot;
    if (this.ready) sendToWindow(this.window, "notch:snapshot", snapshot);
  }

  updateSnooze(until: number | null): void {
    this.snoozedUntil = until;
    if (this.ready) sendToWindow(this.window, "notch:snoozed", until);
    if (until != null) {
      this.pendingNotifications = this.pendingNotifications.filter(isNotchPreview);
      this.collapse();
    }
  }

  pushNotification(notification: NotchNotification): void {
    if (this.ready) {
      sendToWindow(this.window, "notch:notification", notification);
      return;
    }
    this.pendingNotifications = [...this.pendingNotifications, notification].slice(
      -MAX_PENDING_NOTIFICATIONS,
    );
  }

  markReady(): NotchReadyPayload {
    this.ready = true;
    // Each renderer subscribes before calling ready; loading islands queue independently.
    for (const notification of this.pendingNotifications) {
      sendToWindow(this.window, "notch:notification", notification);
    }
    this.pendingNotifications = [];
    return {
      geometry: this.geometry(),
      snapshot: this.snapshot,
      prefs: this.prefs,
      snoozedUntil:
        this.snoozedUntil != null && Date.now() < this.snoozedUntil ? this.snoozedUntil : null,
    };
  }

  setHotRect(rect: NotchHotRect): void {
    this.hotRect = rect;
  }

  collapse(): void {
    if (this.window.isDestroyed() || !this.hovering) return;
    this.hovering = false;
    this.suppressUntilLeave = true;
    this.window.setIgnoreMouseEvents(true, { forward: true });
    sendToWindow(this.window, "notch:hover", false);
  }

  destroy(): void {
    this.stopPolling();
    if (!this.window.isDestroyed()) this.window.destroy();
  }

  private geometry(): NotchGeometry {
    return {
      compactWidth: this.placement.compactWidth,
      notchWidth: this.placement.notchWidth,
      notchHeight: this.placement.notchHeight,
      hardware: this.placement.hardware,
      windowWidth: this.bounds.width,
      windowHeight: this.bounds.height,
    };
  }

  private startPolling(): void {
    const tick = (): void => {
      this.pollTimer = setTimeout(tick, this.samplePointer());
    };
    tick();
  }

  private stopPolling(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  /** Click-through everywhere except this island's live hot rect; sample lazily when far away. */
  private samplePointer(): number {
    const { window: win, bounds, hotRect: rect } = this;
    if (win.isDestroyed() || !this.ready || !rect) return POINTER_IDLE_POLL_MS;
    const point = screen.getCursorScreenPoint();
    const x = point.x - bounds.x;
    const y = point.y - bounds.y;
    const inside =
      rect.width > 0 &&
      rect.height > 0 &&
      x >= rect.x &&
      x <= rect.x + rect.width &&
      y >= rect.y &&
      y <= rect.y + rect.height;
    const near =
      this.hovering ||
      (x >= rect.x - POINTER_NEAR_PX &&
        x <= rect.x + rect.width + POINTER_NEAR_PX &&
        y <= rect.y + rect.height + POINTER_NEAR_PX);
    const next = near ? POINTER_POLL_MS : POINTER_IDLE_POLL_MS;
    if (this.suppressUntilLeave) {
      if (!inside) this.suppressUntilLeave = false;
      return next;
    }
    if (inside === this.hovering) return next;
    this.hovering = inside;
    win.setIgnoreMouseEvents(!inside, { forward: true });
    sendToWindow(win, "notch:hover", inside);
    return POINTER_POLL_MS;
  }
}

function windowBounds({ display }: NotchPlacement): Electron.Rectangle {
  const { bounds } = display;
  const width = Math.min(WINDOW_WIDTH, bounds.width);
  return {
    x: Math.round(bounds.x + (bounds.width - width) / 2),
    y: bounds.y,
    width,
    height: Math.min(WINDOW_HEIGHT, bounds.height),
  };
}

function createWindow(bounds: Electron.Rectangle): BrowserWindow {
  const win = new BrowserWindow({
    ...bounds,
    type: "panel",
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    // The app stays inactive while the island is used, so its first click must land.
    acceptFirstMouse: true,
    skipTaskbar: true,
    enableLargerThanScreen: true,
    roundedCorners: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/notch.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  try {
    // Only opening a conversation may bring Cadencr forward (see `openFeature`).
    preventAppActivation(win);
  } catch (error) {
    win.destroy();
    throw error;
  }
  // Above the menu bar (24) yet below its drop-down menus (101).
  win.setAlwaysOnTop(true, "status");
  win.setIgnoreMouseEvents(true, { forward: true });
  secureWebContents(win.webContents);
  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) win.showInactive();
  });
  void loadNotchPage(win);
  return win;
}

/** Use a separate dev origin so the app's zoom never scales the islands. */
export function notchPageUrl(rendererUrl: string): string {
  const url = new URL("notch.html", rendererUrl);
  if (url.hostname === "127.0.0.1") url.hostname = "localhost";
  else if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.toString();
}

function loadNotchPage(win: BrowserWindow): Promise<void> {
  win.webContents.on("did-finish-load", () => win.webContents.setZoomFactor(1));
  const target = rendererLoadTarget();
  if (target.kind === "url") return win.loadURL(notchPageUrl(target.value));
  return win.loadFile(path.join(path.dirname(target.value), "notch.html"));
}
