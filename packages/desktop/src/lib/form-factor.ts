/**
 * Which layout the renderer shows: the phone layout (drawer sidebar, one tab
 * strip, Enter inserts a newline, no autofocus) or the desktop layout.
 *
 * Rule: phone layout = width ≤ 767px, or a finger as the primary pointer
 * (`(pointer: coarse)`) and width ≤ 1023px.
 *
 * - Width alone is not enough: a phone on its side (≈874×370), an unfolded
 *   foldable (≈951×543) or a tablet in portrait (iPad mini 744, iPad Air 820,
 *   iPad Pro 11" 834) is wider than the phone breakpoint, yet it is still a
 *   touch screen. A touch tablet at 1024px or more (an iPad in landscape, an
 *   iPad Pro 13") keeps the desktop layout.
 * - The primary pointer, not `(any-pointer: fine)`: a stylus counts as a fine
 *   pointer, so a pen phone or a foldable with a pen would fall back to the
 *   desktop layout. A desktop or Electron window (fine primary pointer) keeps
 *   the plain 767px breakpoint.
 * - No height clause: on Android the keyboard shrinks the layout viewport
 *   (`interactive-widget=resizes-content`), so a tablet in landscape would
 *   switch layouts while typing, remount the app shell, close the keyboard and
 *   switch back. Every phone on its side is narrower than 1024px anyway.
 *
 * The answer is mirrored on `<html data-shell="phone|desktop">` for CSS (the
 * `phone:` / `desktop:` Tailwind variants in `index.css`).
 *
 * A second answer, the **tab rail**: on a touch viewport 600px wide or more
 * (a foldable unfolded, a tablet in portrait, a phone on its side), the
 * conversation's tabs are a column on the right of the pane instead of a bar
 * along its bottom, as they are in the system's side strip on an iPhone Duo
 * (`lib/side-strip.ts`): the transcript keeps the screen's height, and the
 * drawer still holds the sidebar, as on a phone in portrait. Width only, so it
 * never comes and goes while a keyboard opens. A narrow desktop window (fine
 * pointer) keeps the bottom bar.
 *
 * A third answer, the **docked sidebar**: a touch screen in the phone layout
 * 900px wide or more (a foldable unfolded on its side, ≈951px; the largest
 * phones on their side, ≈930-956px) keeps the sidebar on screen beside the
 * page, collapsible to the rail as on the desktop, instead of the drawer.
 */

/** At or below this width every device gets the phone layout (the Tailwind `md` floor). */
const PHONE_MAX_WIDTH = 767;
/** A touch device keeps the phone layout up to this width (phones on their side, foldables, tablets in portrait). */
const TOUCH_PHONE_MAX_WIDTH = 1023;
/** From this viewport width a touch screen in the phone layout puts the conversation's tabs in a column on the right. */
const TAB_RAIL_MIN_WIDTH = 600;
/** From this viewport width a touch screen in the phone layout docks the sidebar. */
const DOCKED_SIDEBAR_MIN_WIDTH = 900;

/** The media query answers the layout is computed from. */
interface MediaSignals {
  /** `(max-width: 767px)` */
  phoneWidth: boolean;
  /** `(max-width: 1023px)` */
  compactWidth: boolean;
  /** `(pointer: coarse)`: the primary pointer is a finger. */
  coarsePointer: boolean;
  /** `(min-width: 600px)` */
  railWidth: boolean;
  /** `(min-width: 900px)` */
  dockWidth: boolean;
}

/** Each media query. Kept separate: Safari's support for `not`/`or` nesting is uneven. */
const SIGNAL_QUERIES: Readonly<Record<keyof MediaSignals, string>> = {
  phoneWidth: `(max-width: ${PHONE_MAX_WIDTH}px)`,
  compactWidth: `(max-width: ${TOUCH_PHONE_MAX_WIDTH}px)`,
  coarsePointer: "(pointer: coarse)",
  railWidth: `(min-width: ${TAB_RAIL_MIN_WIDTH}px)`,
  dockWidth: `(min-width: ${DOCKED_SIDEBAR_MIN_WIDTH}px)`,
};

function isPhoneShell(signals: MediaSignals): boolean {
  return signals.phoneWidth || (signals.coarsePointer && signals.compactWidth);
}

function hasDockedSidebar(signals: MediaSignals): boolean {
  return isPhoneShell(signals) && signals.coarsePointer && signals.dockWidth;
}

function hasTabRail(signals: MediaSignals): boolean {
  return isPhoneShell(signals) && signals.coarsePointer && signals.railWidth;
}

// ─── Live store ──────────────────────────────────────────────────────────
// One set of MediaQueryLists for the whole renderer, created on first read and
// listened to for the app's lifetime: every `useIsMobile()` / `useIsTouchDevice()`
// / `useTabRail()` consumer and the `data-shell` attribute
// share it, so no component adds a listener of its own.

type SignalLists = Record<keyof MediaSignals, MediaQueryList>;

let lists: SignalLists | null = null;
let phoneShell = false;
let coarsePointer = false;
let tabRail = false;
let dockedSidebar = false;
let mirrorsAttribute = false;
const listeners = new Set<() => void>();

function readSignals(current: SignalLists): MediaSignals {
  return {
    phoneWidth: current.phoneWidth.matches,
    compactWidth: current.compactWidth.matches,
    coarsePointer: current.coarsePointer.matches,
    railWidth: current.railWidth.matches,
    dockWidth: current.dockWidth.matches,
  };
}

function writeShellAttribute(): void {
  const { dataset } = document.documentElement;
  dataset.shell = phoneShell ? "phone" : "desktop";
}

/** Recomputes every answer; subscribers hear only about one that changed. */
function refresh(): void {
  if (!lists) return;
  const signals = readSignals(lists);
  const nextPhoneShell = isPhoneShell(signals);
  const nextTabRail = hasTabRail(signals);
  const nextDocked = hasDockedSidebar(signals);
  const layoutChanged =
    nextPhoneShell !== phoneShell || nextTabRail !== tabRail || nextDocked !== dockedSidebar;
  if (!layoutChanged && signals.coarsePointer === coarsePointer) return;
  const shellChanged = nextPhoneShell !== phoneShell;
  phoneShell = nextPhoneShell;
  tabRail = nextTabRail;
  dockedSidebar = nextDocked;
  coarsePointer = signals.coarsePointer;
  if (mirrorsAttribute && shellChanged) writeShellAttribute();
  for (const listener of listeners) listener();
}

function ensureStarted(): void {
  if (lists || typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  const created: SignalLists = {
    phoneWidth: window.matchMedia(SIGNAL_QUERIES.phoneWidth),
    compactWidth: window.matchMedia(SIGNAL_QUERIES.compactWidth),
    coarsePointer: window.matchMedia(SIGNAL_QUERIES.coarsePointer),
    railWidth: window.matchMedia(SIGNAL_QUERIES.railWidth),
    dockWidth: window.matchMedia(SIGNAL_QUERIES.dockWidth),
  };
  lists = created;
  const signals = readSignals(created);
  phoneShell = isPhoneShell(signals);
  tabRail = hasTabRail(signals);
  dockedSidebar = hasDockedSidebar(signals);
  coarsePointer = signals.coarsePointer;
  // Width and pointer queries only: their `change` fires whenever an answer
  // flips, a fold's last size change included, with or without a `resize`.
  for (const list of Object.values(created)) list.addEventListener("change", refresh);
}

/** `useSyncExternalStore` subscribe: fires when the layout, the tab rail or the primary pointer flip. */
export function subscribeFormFactor(onChange: () => void): () => void {
  ensureStarted();
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** Whether the phone layout renders right now. */
export function getPhoneShellSnapshot(): boolean {
  ensureStarted();
  return phoneShell;
}

/** Whether the phone layout puts the conversation's tabs in a column on the right (touch, 600px wide or more). */
export function getTabRailSnapshot(): boolean {
  ensureStarted();
  return tabRail;
}

/** Whether the phone layout docks the sidebar beside the page (touch, 900px wide or more). */
export function getDockedSidebarSnapshot(): boolean {
  ensureStarted();
  return dockedSidebar;
}

/**
 * Whether the primary pointer is a finger (`(pointer: coarse)`): keyboard hints
 * hide then, like the `[data-kbd-hint]` rule in `touch-shell.css`.
 */
export function getCoarsePointerSnapshot(): boolean {
  ensureStarted();
  return coarsePointer;
}

/**
 * Writes `data-shell` on `<html>` now and keeps it current. Call once from the
 * entry, before React renders, so the first paint already has the right layout.
 */
export function installShellAttribute(): void {
  ensureStarted();
  if (typeof document === "undefined") return;
  mirrorsAttribute = true;
  writeShellAttribute();
}
