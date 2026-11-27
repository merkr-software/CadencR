import { useSyncExternalStore } from "react";
import { getPhoneShellSnapshot, subscribeFormFactor } from "@/lib/form-factor";

function getServerSnapshot(): boolean {
  return false;
}

/**
 * `true` when the renderer shows the phone layout (`lib/form-factor.ts`): any
 * viewport up to 767px wide, plus a touch primary pointer up to 1023px wide
 * (phones on their side, unfolded foldables, tablets in portrait). A device
 * with a fine primary pointer (desktop, Electron) keeps the plain width
 * breakpoint. Drives phone-only decisions (drawer sidebar, single tab strip,
 * Enter inserts a newline, no autofocus, the phone zoom level in a browser)
 * and follows resizes, rotation and folding. The same answer is on
 * `<html data-shell>` for CSS. SSR-safe via a constant server snapshot (the
 * renderer is client-only).
 */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribeFormFactor, getPhoneShellSnapshot, getServerSnapshot);
}

/** The same answer read once, for code outside React (palette command lists). */
export function isMobileViewport(): boolean {
  return getPhoneShellSnapshot();
}
