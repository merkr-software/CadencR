import { watchViewport } from "./viewport-settle";

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
 * A second answer, the **panes**: the phone layout has room for two panes, the
 * Agents inbox beside the conversation, on a touch viewport 600px wide and
 * 600px tall or more: a foldable unfolded, a tablet in portrait. A phone on
 * its side is wide enough but only ≈370px tall, which leaves the conversation
 * pane no room for a transcript between its header, its composer and its tab
 * bar, so it keeps one pane. The viewport, not `screen`: an iPhone Duo reports
 * its outer (folded) screen, 466×678, while unfolded. A keyboard shortens the
 * viewport (Android's `resizes-content`) but never changes its width, so a
 * height drop at the same width keeps two panes: they don't come and go while
 * typing. Mirrored on `<html data-panes="1|2">`. A narrow desktop window (fine
 * pointer) keeps one pane.
 *
 * A third answer, the **docked sidebar**: a touch screen in the phone layout
 * 900px wide or more (a foldable unfolded on its side, ≈951px; the largest
 * phones on their side, ≈930-956px) keeps the sidebar on screen beside the
 * page, collapsible to the rail as on the desktop, instead of the drawer. The
 * sidebar then lists what the inbox pane would, so two panes give way to it.
 */

/** At or below this width every device gets the phone layout (the Tailwind `md` floor). */
const PHONE_MAX_WIDTH = 767;
/** A touch device keeps the phone layout up to this width (phones on their side, foldables, tablets in portrait). */
const TOUCH_PHONE_MAX_WIDTH = 1023;
/** From this viewport width and height a touch screen in the phone layout shows two panes (inbox + conversation). */
const TWO_PANES_MIN_SIZE = 600;
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
  paneWidth: boolean;
  /** `(min-width: 900px)` */
  dockWidth: boolean;
}

interface FormFactorSignals extends MediaSignals {
  /** Tall enough for two panes, a keyboard aside (`readPaneHeight`). */
  roomyHeight: boolean;
}

/** The media queries the store listens to: the signals, and the height behind `roomyHeight`. */
type ListenedQuery = keyof MediaSignals | "paneHeight";

/** Each media query. Kept separate: Safari's support for `not`/`or` nesting is uneven. */
const SIGNAL_QUERIES: Readonly<Record<ListenedQuery, string>> = {
  phoneWidth: `(max-width: ${PHONE_MAX_WIDTH}px)`,
  compactWidth: `(max-width: ${TOUCH_PHONE_MAX_WIDTH}px)`,
  coarsePointer: "(pointer: coarse)",
  paneWidth: `(min-width: ${TWO_PANES_MIN_SIZE}px)`,
  dockWidth: `(min-width: ${DOCKED_SIDEBAR_MIN_WIDTH}px)`,
  paneHeight: `(min-height: ${TWO_PANES_MIN_SIZE}px)`,
};

function isPhoneShell(signals: FormFactorSignals): boolean {
  return signals.phoneWidth || (signals.coarsePointer && signals.compactWidth);
}

function hasDockedSidebar(signals: FormFactorSignals): boolean {
  return isPhoneShell(signals) && signals.coarsePointer && signals.dockWidth;
}

function hasTwoPanes(signals: FormFactorSignals): boolean {
  return (
    isPhoneShell(signals) &&
    signals.coarsePointer &&
    signals.paneWidth &&
    signals.roomyHeight &&
    !hasDockedSidebar(signals)
  );
}

// ─── Live store ──────────────────────────────────────────────────────────
// One set of MediaQueryLists for the whole renderer, created on first read and
// listened to for the app's lifetime: every `useIsMobile()` / `useIsTouchDevice()`
// / `useTwoPanes()` consumer and the `data-shell` / `data-panes` attributes
// share it, so no component adds a listener of its own.

type SignalLists = Record<ListenedQuery, MediaQueryList>;

let lists: SignalLists | null = null;
let phoneShell = false;
let coarsePointer = false;
let twoPanes = false;
let dockedSidebar = false;
let mirrorsAttribute = false;
/** The last `(min-height)` answer kept and the width it was read at (`readPaneHeight`). */
let roomyHeight = false;
let roomyHeightWidth = -1;
const listeners = new Set<() => void>();

/** Whether a text field has the focus, the only time an on-screen keyboard is up. */
function isEditing(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  return active.isContentEditable || active.matches("input, textarea, select");
}

/**
 * Whether the viewport is tall enough for two panes. A drop at an unchanged
 * width while a field has the focus is a keyboard opening, so it keeps the
 * previous answer. Without a field focused it is a fold or a rotation, which
 * reports its new width before its new height.
 */
function readPaneHeight(tall: boolean): boolean {
  const width = window.innerWidth;
  const keyboard = !tall && roomyHeight && width === roomyHeightWidth && isEditing();
  roomyHeightWidth = width;
  if (!keyboard) roomyHeight = tall;
  return roomyHeight;
}

function readSignals(current: SignalLists): FormFactorSignals {
  return {
    phoneWidth: current.phoneWidth.matches,
    compactWidth: current.compactWidth.matches,
    coarsePointer: current.coarsePointer.matches,
    paneWidth: current.paneWidth.matches,
    dockWidth: current.dockWidth.matches,
    roomyHeight: readPaneHeight(current.paneHeight.matches),
  };
}

function writeShellAttributes(): void {
  const { dataset } = document.documentElement;
  dataset.shell = phoneShell ? "phone" : "desktop";
  dataset.panes = twoPanes ? "2" : "1";
}

/** Recomputes every answer; subscribers hear only about one that changed. */
function refresh(): void {
  if (!lists) return;
  const signals = readSignals(lists);
  const nextPhoneShell = isPhoneShell(signals);
  const nextTwoPanes = hasTwoPanes(signals);
  const nextDocked = hasDockedSidebar(signals);
  const shellChanged =
    nextPhoneShell !== phoneShell || nextTwoPanes !== twoPanes || nextDocked !== dockedSidebar;
  if (!shellChanged && signals.coarsePointer === coarsePointer) return;
  phoneShell = nextPhoneShell;
  twoPanes = nextTwoPanes;
  dockedSidebar = nextDocked;
  coarsePointer = signals.coarsePointer;
  if (mirrorsAttribute && shellChanged) writeShellAttributes();
  for (const listener of listeners) listener();
}

function ensureStarted(): void {
  if (lists || typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  const created: SignalLists = {
    phoneWidth: window.matchMedia(SIGNAL_QUERIES.phoneWidth),
    compactWidth: window.matchMedia(SIGNAL_QUERIES.compactWidth),
    coarsePointer: window.matchMedia(SIGNAL_QUERIES.coarsePointer),
    paneWidth: window.matchMedia(SIGNAL_QUERIES.paneWidth),
    dockWidth: window.matchMedia(SIGNAL_QUERIES.dockWidth),
    paneHeight: window.matchMedia(SIGNAL_QUERIES.paneHeight),
  };
  lists = created;
  const signals = readSignals(created);
  phoneShell = isPhoneShell(signals);
  twoPanes = hasTwoPanes(signals);
  dockedSidebar = hasDockedSidebar(signals);
  coarsePointer = signals.coarsePointer;
  for (const list of Object.values(created)) list.addEventListener("change", refresh);
  // A fold can change the viewport without crossing a query (669→678px wide
  // between an unfolded Duo and a folded one on its side), and the height hold
  // must see that width change: read again on every viewport change too.
  watchViewport(refresh);
}

/** `useSyncExternalStore` subscribe: fires when the layout, the panes or the primary pointer flip. */
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

/** Whether the phone layout shows two panes (touch, a viewport 600px wide and tall or more). */
export function getTwoPanesSnapshot(): boolean {
  ensureStarted();
  return twoPanes;
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
 * Writes `data-shell` and `data-panes` on `<html>` now and keeps them current. Call once from the
 * entry, before React renders, so the first paint already has the right layout.
 */
export function installShellAttribute(): void {
  ensureStarted();
  if (typeof document === "undefined") return;
  mirrorsAttribute = true;
  writeShellAttributes();
}
