/**
 * Read the resolved animations preference straight from `<html data-animations>`
 * (written by `AnimationsProvider`). Avoids subscribing hot-path components to
 * the underlying setting.
 */
export function animationsDisabled(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.dataset.animations === "off";
}
