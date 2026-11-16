/**
 * App zoom levels in percent, independent of what they scale or where they are
 * stored, so a zoom per workspace tab can share them with its own storage and
 * apply step. (Browser guest tabs keep Chromium's own zoom steps.)
 */
const ZOOM_DEFAULT = 100;
const ZOOM_MIN = 50;
const ZOOM_MAX = 200;
const ZOOM_STEP = 10;

export type ZoomStep = "in" | "out" | "reset";

export function clampZoom(level: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, level));
}

export function stepZoom(level: number, step: ZoomStep): number {
  if (step === "reset") return ZOOM_DEFAULT;
  return clampZoom(level + (step === "in" ? ZOOM_STEP : -ZOOM_STEP));
}

/**
 * The level a stored value stands for. The backend stores any number, so an
 * unset, empty or non-numeric value means the default and an out-of-range one is
 * clamped rather than rejected by the native zoom.
 */
export function parseZoomLevel(value: string | null): number {
  const level = value === null || value.trim() === "" ? Number.NaN : Number(value);
  return Number.isFinite(level) ? clampZoom(level) : ZOOM_DEFAULT;
}
