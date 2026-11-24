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
 * Agents inbox beside the conversation, on a touch screen whose viewport is
 * 600px wide or more and whose physical screen's short side is 600px or more
 * (`Math.min(screen.width, screen.height)`): a foldable unfolded, a tablet in
 * portrait. A phone on its side is wide enough but only ≈370px tall, which
 * leaves the conversation pane no room for a transcript between its header,
 * its composer and its tab bar, so it keeps one pane: its screen's short side
 * is ≈400px. The screen, not the viewport's height: the screen does not shrink
 * when a keyboard opens and its short side does not change with the
 * orientation, so a pane never comes and goes while typing or turning. Mirrored
 * on `<html data-panes="1|2">`. A narrow desktop window (fine pointer) keeps
 * one pane.
 */

/** At or below this width every device gets the phone layout (the Tailwind `md` floor). */
const PHONE_MAX_WIDTH = 767;
/** A touch device keeps the phone layout up to this width (phones on their side, foldables, tablets in portrait). */
const TOUCH_PHONE_MAX_WIDTH = 1023;
/**
 * From this viewport width, on a screen whose short side is at least as long,
 * a touch screen in the phone layout shows two panes (inbox + conversation).
 */
const TWO_PANES_MIN_SIZE = 600;

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
}

interface FormFactorSignals extends MediaSignals {
  /** The physical screen's short side is 600px or more (`screen`, read on each refresh). */
  roomyScreen: boolean;
}

/** Each signal's media query. Kept separate: Safari's support for `not`/`or` nesting is uneven. */
const SIGNAL_QUERIES: Readonly<Record<keyof MediaSignals, string>> = {
  phoneWidth: `(max-width: ${PHONE_MAX_WIDTH}px)`,
  compactWidth: `(max-width: ${TOUCH_PHONE_MAX_WIDTH}px)`,
  coarsePointer: "(pointer: coarse)",
  paneWidth: `(min-width: ${TWO_PANES_MIN_SIZE}px)`,
};

function isPhoneShell(signals: FormFactorSignals): boolean {
  return signals.phoneWidth || (signals.coarsePointer && signals.compactWidth);
}

function hasTwoPanes(signals: FormFactorSignals): boolean {
  return isPhoneShell(signals) && signals.coarsePointer && signals.paneWidth && signals.roomyScreen;
}

/**
 * Whether the screen's short side leaves room for two panes. No listener of
 * its own: the screen changes with a fold or a rotation, which also cross the
 * width queries (a fold crosses 600px), and its short side does not change
 * with the orientation.
 */
function readRoomyScreen(): boolean {
  const { screen } = window;
  return Math.min(screen.width, screen.height) >= TWO_PANES_MIN_SIZE;
}

// ─── Live store ──────────────────────────────────────────────────────────
// One set of MediaQueryLists for the whole renderer, created on first read and
// listened to for the app's lifetime: every `useIsMobile()` / `useIsTouchDevice()`
// / `useTwoPanes()` consumer and the `data-shell` / `data-panes` attributes
// share it, so no component adds a listener of its own.

type SignalLists = Record<keyof MediaSignals, MediaQueryList>;

let lists: SignalLists | null = null;
let phoneShell = false;
let coarsePointer = false;
let twoPanes = false;
let mirrorsAttribute = false;
const listeners = new Set<() => void>();

function readSignals(current: SignalLists): FormFactorSignals {
  return {
    phoneWidth: current.phoneWidth.matches,
    compactWidth: current.compactWidth.matches,
    coarsePointer: current.coarsePointer.matches,
    paneWidth: current.paneWidth.matches,
    roomyScreen: readRoomyScreen(),
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
  const shellChanged = nextPhoneShell !== phoneShell || nextTwoPanes !== twoPanes;
  if (!shellChanged && signals.coarsePointer === coarsePointer) return;
  phoneShell = nextPhoneShell;
  twoPanes = nextTwoPanes;
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
  };
  lists = created;
  const signals = readSignals(created);
  phoneShell = isPhoneShell(signals);
  twoPanes = hasTwoPanes(signals);
  coarsePointer = signals.coarsePointer;
  for (const list of Object.values(created)) list.addEventListener("change", refresh);
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

/** Whether the phone layout shows two panes (touch, 600px wide or more on a screen at least 600px on its short side). */
export function getTwoPanesSnapshot(): boolean {
  ensureStarted();
  return twoPanes;
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
