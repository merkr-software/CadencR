import type { BrowserBounds } from "./browser-types";
import type { BrowserWindow } from "electron";
import { browserPageBounds } from "../../src/shared/browser-responsive";

export interface BrowserWindowOffset {
  x: number;
  y: number;
}

/**
 * Convert renderer viewport bounds (CSS px, in the main window's zoomed coordinate
 * space) into window DIP. `getBoundingClientRect` is scaled by the page zoom factor,
 * but `WebContentsView.setBounds` expects unzoomed window points — without this the
 * native view is mis-sized and shifted toward the origin whenever UI zoom ≠ 100%.
 */
export function scaleBounds(bounds: BrowserBounds, zoomFactor: number): BrowserBounds {
  const factor = zoomFactor > 0 ? zoomFactor : 1;
  return {
    x: bounds.x * factor,
    y: bounds.y * factor,
    width: bounds.width * factor,
    height: bounds.height * factor,
  };
}

export function sanitizeBounds(bounds: BrowserBounds): BrowserBounds {
  return {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
  };
}

export function windowRelativeBounds(
  bounds: BrowserBounds,
  offset: BrowserWindowOffset,
): BrowserBounds {
  const clean = sanitizeBounds(bounds);
  return {
    ...clean,
    x: clean.x + Math.max(0, Math.round(offset.x)),
    y: clean.y + Math.max(0, Math.round(offset.y)),
  };
}

export function contentOffset(win: BrowserWindow | null): BrowserWindowOffset {
  if (!win) return { x: 0, y: 0 };
  const frame = win.getBounds();
  const content = win.getContentBounds();
  return { x: content.x - frame.x, y: content.y - frame.y };
}

/**
 * Renderer placeholder rect (zoomed CSS px from `getBoundingClientRect`) →
 * window DIP for `WebContentsView.setBounds`. `zoomFactor` is the renderer's
 * page zoom as measured with the rect; it falls back to the window's own.
 */
export function rendererBoundsToWindow(
  win: BrowserWindow | null,
  bounds: BrowserBounds,
  zoomFactor?: number,
): { bounds: BrowserBounds; factor: number } {
  const factor = zoomFactor ?? win?.webContents.getZoomFactor() ?? 1;
  return {
    bounds: windowRelativeBounds(scaleBounds(bounds, factor), contentOffset(win)),
    factor,
  };
}

/**
 * Off-screen position for a view that should be hidden, preserving its size so
 * the page doesn't reflow to a 1px box on every toggle. Sizing matters because
 * we move a view off-screen *while it is still visible* (a hidden
 * `WebContentsView` keeps its last hit-test region, so it would otherwise keep
 * swallowing clicks meant for React overlays painted over the viewport).
 */
export function offscreenBounds(bounds: BrowserBounds): BrowserBounds {
  return {
    x: -10000 - Math.max(0, bounds.width),
    y: 0,
    width: bounds.width,
    height: bounds.height,
  };
}

export function browserBounds(bounds: BrowserBounds, devtoolsOpen: boolean): BrowserBounds {
  return browserPageBounds(bounds, devtoolsOpen);
}

export function devtoolsBounds(bounds: BrowserBounds): BrowserBounds {
  const top = browserPageBounds(bounds, true).height;
  return {
    x: bounds.x,
    y: bounds.y + top,
    width: bounds.width,
    height: Math.max(1, bounds.height - top),
  };
}
