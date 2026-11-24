import { create } from "zustand";
import { parseHotkey, type Hotkey, type HotkeyCallbackContext } from "@tanstack/hotkeys";
import type { ShortcutId } from "@/lib/shortcuts/registry";

/**
 * The live handlers behind the shortcuts the palette lists. Each id-based
 * shortcut hook registers its callback here while it is mounted and enabled,
 * so running "Commit…" from the palette calls exactly what ⌘⇧C calls — no
 * synthetic key events, and a command only shows while something can run it.
 * Several hosts may register one id (unified agents cards); the newest wins.
 */

/** Runs the handler; `false` when it looked and declined (it did not take the event). */
type ShortcutRun = () => boolean | void;

interface Registration {
  token: number;
  run: ShortcutRun;
}

interface ShortcutActionState {
  byId: Partial<Record<ShortcutId, readonly Registration[]>>;
}

export const useShortcutActionStore = create<ShortcutActionState>(() => ({ byId: {} }));

let nextToken = 1;

/** Registers a handler; returns its unregister function. */
export function registerShortcutAction(id: ShortcutId, run: ShortcutRun): () => void {
  const token = nextToken++;
  useShortcutActionStore.setState((state) => ({
    byId: { ...state.byId, [id]: [...(state.byId[id] ?? []), { token, run }] },
  }));
  return () =>
    useShortcutActionStore.setState((state) => {
      const remaining = (state.byId[id] ?? []).filter((entry) => entry.token !== token);
      const byId = { ...state.byId };
      if (remaining.length > 0) byId[id] = remaining;
      else delete byId[id];
      return { byId };
    });
}

/** Runs the newest handler for `id`; `false` when nothing can run it now. */
export function runShortcutAction(id: ShortcutId): boolean {
  return runShortcutActionOutcome(id) !== "missing";
}

/**
 * Runs the newest handler for `id` and says what happened: `missing` when
 * nothing can run it now, `declined` when its handler looked and passed (the
 * key binding would have let the chord through), else `handled`.
 */
export function runShortcutActionOutcome(id: ShortcutId): "missing" | "declined" | "handled" {
  const run = useShortcutActionStore.getState().byId[id]?.at(-1)?.run;
  if (!run) return "missing";
  return run() === false ? "declined" : "handled";
}

/**
 * A keydown standing in for the chord, for handlers that read the event
 * (`preventDefault`, `target`). Its target is the document body: nothing is
 * focused while the palette closes.
 */
export function paletteKeyboardEvent(): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "target", { value: document.body });
  return event;
}

/** The context TanStack hands a hotkey callback, for the chord `hotkey`. */
export function paletteHotkeyContext(hotkey: string): HotkeyCallbackContext {
  return { hotkey: hotkey as Hotkey, parsedHotkey: parseHotkey(hotkey) };
}
