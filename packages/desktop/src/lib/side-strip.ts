import {
  getDockedSidebarSnapshot,
  getPhoneShellSnapshot,
  getTwoPanesSnapshot,
  subscribeFormFactor,
} from "./form-factor";
import { watchViewport } from "./viewport-settle";

/**
 * The system's side strip on an iPhone Duo (iOS 27.1, measured in the
 * home-screen app): folded, and unfolded on its side, iOS keeps an 84pt
 * column along one edge for the status bar and the Dynamic Island (the camera
 * when folded on its side) and reports it as that side's safe-area inset, the
 * other side's being 0. Native apps put their tab bar and toolbar in that
 * column, under the status bar ("the system moves controls to the side",
 * Apple's iPhone Duo guidelines); the phone layout does the same:
 *
 * - `<html data-side-strip="left|right">`: the main column keeps off the
 *   strip, so nothing renders under the status bar or the camera. Unset when
 *   the strip is on the left behind a docked sidebar, which already keeps
 *   off it.
 * - `<html data-strip-rail="left|right">`: the conversation's tab bar is a
 *   vertical rail inside the strip (`phone-side-strip.css`), beside the
 *   conversation: on the right, or on the left in one pane.
 *
 * A phone on its side reports the same inset on both sides (its notch or
 * Dynamic Island, then the room it mirrors), so it has no strip. iOS only:
 * an Android phone on its side can report a one-sided inset for a punch-hole
 * camera in the middle of that edge, where the rail would land on it.
 */
export type StripSide = "left" | "right";

/** A side inset at least this wide, with none on the other side, is a strip. */
const STRIP_MIN_WIDTH = 40;

export interface SideStrip {
  /** Where the main column keeps off a strip. */
  strip: StripSide | null;
  /** Where the conversation's tab rail sits. */
  rail: StripSide | null;
}

const NONE: SideStrip = { strip: null, rail: null };

/** The side the system reserves, from the left and right safe-area insets. */
export function stripSide(left: number, right: number): StripSide | null {
  if (right >= STRIP_MIN_WIDTH && left < 1) return "right";
  if (left >= STRIP_MIN_WIDTH && right < 1) return "left";
  return null;
}

/** What the layout does with the system's strip (see the module comment). */
export function resolveSideStrip(
  system: StripSide | null,
  layout: { phone: boolean; docked: boolean; twoPanes: boolean },
): SideStrip {
  if (!system || !layout.phone) return NONE;
  if (system === "left" && layout.docked) return NONE;
  const rail = system === "right" || !layout.twoPanes ? system : null;
  return { strip: system, rail };
}

// ─── Live store ──────────────────────────────────────────────────────────

let current: SideStrip = NONE;
const listeners = new Set<() => void>();

/** `useSyncExternalStore` subscribe: fires when the strip or the rail moves. */
export function subscribeSideStrip(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** Where the conversation's tab rail sits, or null for the bottom bar. */
export function getStripRailSnapshot(): StripSide | null {
  return current.rail;
}

function writeAttribute(name: "sideStrip" | "stripRail", side: StripSide | null): void {
  const { dataset } = document.documentElement;
  if (side) dataset[name] = side;
  else delete dataset[name];
}

/** A hidden element padded with the side insets, read back as pixels. */
function createInsetProbe(): HTMLElement {
  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.dataset.insetProbe = "";
  probe.style.cssText =
    "position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;" +
    "padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px)";
  document.documentElement.appendChild(probe);
  return probe;
}

/** iOS WebKit, the only engine whose side strip is the Duo's (see the module comment). */
function isIosWebKit(): boolean {
  return window.CSS?.supports("-webkit-touch-callout", "none") ?? false;
}

/**
 * Writes `data-side-strip` and `data-strip-rail` on `<html>` and keeps them
 * current through folds, rotations and layout changes. Call once from the
 * entry, after `installShellAttribute`. Does nothing outside iOS.
 */
export function installSideStrip(): () => void {
  if (!isIosWebKit()) return () => {};
  const probe = createInsetProbe();
  // Live: it reflects the probe's current values at each read.
  const style = getComputedStyle(probe);
  const update = (): void => {
    // The desktop layout never has a strip: skip the style read.
    const phone = getPhoneShellSnapshot();
    const system = phone
      ? stripSide(parseFloat(style.paddingLeft) || 0, parseFloat(style.paddingRight) || 0)
      : null;
    const next = resolveSideStrip(system, {
      phone,
      docked: getDockedSidebarSnapshot(),
      twoPanes: getTwoPanesSnapshot(),
    });
    if (next.strip === current.strip && next.rail === current.rail) return;
    current = next;
    writeAttribute("sideStrip", next.strip);
    writeAttribute("stripRail", next.rail);
    for (const listener of listeners) listener();
  };
  const stopViewport = watchViewport(update);
  const stopLayout = subscribeFormFactor(update);
  return () => {
    stopViewport();
    stopLayout();
    probe.remove();
    current = NONE;
    writeAttribute("sideStrip", null);
    writeAttribute("stripRail", null);
  };
}
