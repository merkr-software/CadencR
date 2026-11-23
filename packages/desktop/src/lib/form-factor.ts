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
 */

/** At or below this width every device gets the phone layout (the Tailwind `md` floor). */
const PHONE_MAX_WIDTH = 767;
/** A touch device keeps the phone layout up to this width (phones on their side, foldables, tablets in portrait). */
const TOUCH_PHONE_MAX_WIDTH = 1023;

/** The media query answers the layout is computed from. */
interface FormFactorSignals {
  /** `(max-width: 767px)` */
  phoneWidth: boolean;
  /** `(max-width: 1023px)` */
  compactWidth: boolean;
  /** `(pointer: coarse)`: the primary pointer is a finger. */
  coarsePointer: boolean;
}

/** Each signal's media query. Kept separate: Safari's support for `not`/`or` nesting is uneven. */
const SIGNAL_QUERIES: Readonly<Record<keyof FormFactorSignals, string>> = {
  phoneWidth: `(max-width: ${PHONE_MAX_WIDTH}px)`,
  compactWidth: `(max-width: ${TOUCH_PHONE_MAX_WIDTH}px)`,
  coarsePointer: "(pointer: coarse)",
};

function isPhoneShell(signals: FormFactorSignals): boolean {
  return signals.phoneWidth || (signals.coarsePointer && signals.compactWidth);
}

// ─── Live store ──────────────────────────────────────────────────────────
// One set of MediaQueryLists for the whole renderer, created on first read and
// listened to for the app's lifetime: every `useIsMobile()` / `useIsTouchDevice()`
// consumer and the `data-shell` attribute share it, so no component adds a
// listener of its own.

type SignalLists = Record<keyof FormFactorSignals, MediaQueryList>;

let lists: SignalLists | null = null;
let phoneShell = false;
let coarsePointer = false;
let mirrorsAttribute = false;
const listeners = new Set<() => void>();

function readSignals(current: SignalLists): FormFactorSignals {
  return {
    phoneWidth: current.phoneWidth.matches,
    compactWidth: current.compactWidth.matches,
    coarsePointer: current.coarsePointer.matches,
  };
}

function writeShellAttribute(): void {
  document.documentElement.dataset.shell = phoneShell ? "phone" : "desktop";
}

/** Recomputes both answers; subscribers hear only about one that changed. */
function refresh(): void {
  if (!lists) return;
  const signals = readSignals(lists);
  const nextPhoneShell = isPhoneShell(signals);
  const shellChanged = nextPhoneShell !== phoneShell;
  if (!shellChanged && signals.coarsePointer === coarsePointer) return;
  phoneShell = nextPhoneShell;
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
  };
  lists = created;
  const signals = readSignals(created);
  phoneShell = isPhoneShell(signals);
  coarsePointer = signals.coarsePointer;
  for (const list of Object.values(created)) list.addEventListener("change", refresh);
}

/** `useSyncExternalStore` subscribe: fires when the layout or the primary pointer flips. */
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
