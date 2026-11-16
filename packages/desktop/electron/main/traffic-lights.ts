import type { BrowserWindow, Point } from "electron";
import { requiredNumber } from "./browser-arg-validation";

// Where macOS draws the window buttons under `titleBarStyle: "hiddenInset"`
// (measured on macOS 26): 14pt buttons whose row starts 12pt from the left.
const LIGHTS_X = 12;
const LIGHT_SIZE = 14;
// Generous bound on a titlebar band's center, in CSS px.
const MAX_CENTER = 200;

// The center each window's renderer asked for, in CSS px, so a zoom change
// can re-apply it. Absent means the system position.
const requestedCenters = new WeakMap<BrowserWindow, number>();
const watchedWindows = new WeakSet<BrowserWindow>();

export function parseTrafficLightsCenter(raw: unknown): number | null {
  if (raw === null) return null;
  const center = requiredNumber(raw, "a traffic lights center or null");
  if (center < 0 || center > MAX_CENTER) {
    throw new Error(`Traffic lights center must be between 0 and ${MAX_CENTER}.`);
  }
  return center;
}

/**
 * Native position that centers the buttons on a renderer band whose center is
 * `center` CSS px from the top. The band scales with the page zoom while the
 * buttons don't, so the center is converted to window points first.
 */
export function trafficLightsPosition(center: number | null, zoomFactor: number): Point | null {
  if (center === null) return null;
  return { x: LIGHTS_X, y: Math.max(0, Math.round(center * zoomFactor - LIGHT_SIZE / 2)) };
}

export function setTrafficLightsCenter(win: BrowserWindow, center: number | null): void {
  if (center === null) requestedCenters.delete(win);
  else requestedCenters.set(win, center);
  applyTrafficLights(win);
  if (center === null || watchedWindows.has(win)) return;
  // A reload (⌘R, crash recovery) drops the renderer that would have sent
  // null, and it may come back expanded: start over from the system position.
  watchedWindows.add(win);
  win.webContents.on("did-navigate", () => setTrafficLightsCenter(win, null));
}

/** Re-places the buttons for the window's current zoom. No-op off macOS. */
export function applyTrafficLights(win: BrowserWindow): void {
  if (process.platform !== "darwin") return;
  const center = requestedCenters.get(win) ?? null;
  win.setWindowButtonPosition(trafficLightsPosition(center, win.webContents.getZoomFactor()));
}
