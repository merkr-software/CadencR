import { matchesKeyboardEvent, parseHotkey } from "@tanstack/hotkeys";
import { useEffect, useRef } from "react";
import { expandCharacterHotkey } from "@/lib/shortcuts/character-hotkeys";
import { shellOwnsKeyEvent } from "@/lib/shortcuts/shell-keys";

interface GlobalShortcutOptions {
  /** When false, the listener is not attached. Default: true. */
  enabled?: boolean;
}

function normalizeTanStackShortcut(shortcut: string): string {
  return shortcut
    .split("+")
    .map((part) => part.trim())
    .join("+");
}

/**
 * An Alt/Option digit chord (Mod+Alt+1) matched by physical key. Option on
 * macOS and AZERTY's unshifted digit row change what the key types (`¡`, `&`)
 * but not which key it is. Chords without Alt keep the layout-aware match, so
 * ⌘⇧! on QWERTY never reads as ⌘1.
 */
function matchesAltDigitByCode(e: KeyboardEvent, parsed: ReturnType<typeof parseHotkey>): boolean {
  const key = parsed.key ?? "";
  if (!parsed.alt || !/^[0-9]$/.test(key) || e.code !== `Digit${key}`) return false;
  return e.altKey && e.ctrlKey === parsed.ctrl && e.metaKey === parsed.meta;
}

/**
 * Capture-phase keydown listener that fires before CodeMirror, xterm.js,
 * or any other embedded component can swallow the event.
 *
 * Use this instead of TanStack's React hook when the shortcut must work
 * before CodeMirror, xterm.js, or another embedded surface can stop
 * propagation. Matching still goes through `@tanstack/hotkeys`, so layout
 * behavior stays consistent with normal shortcuts.
 *
 * Accepts a single combo or an array of combos — pass multiple when one
 * action needs to fire on layout-specific alternatives (e.g. `Mod+/` on
 * QWERTY plus `Mod+?` on AZERTY).
 */
export function useGlobalShortcut(
  shortcut: string | readonly string[],
  callback: (e: KeyboardEvent) => void,
  options?: GlobalShortcutOptions,
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  const enabledRef = useRef(true);
  enabledRef.current = options?.enabled ?? true;

  const shortcutKey = Array.isArray(shortcut) ? shortcut.join("|") : (shortcut as string);

  useEffect(() => {
    const combos = Array.isArray(shortcut) ? shortcut : [shortcut as string];
    const variants = combos.flatMap((combo) =>
      expandCharacterHotkey(normalizeTanStackShortcut(combo)).map((variant) => ({
        ...variant,
        parsed: parseHotkey(variant.hotkey),
      })),
    );
    const handler = (e: KeyboardEvent) => {
      if (!enabledRef.current || shellOwnsKeyEvent(e)) return;
      const matches = variants.some((variant) => {
        // Keep navigation chords distinct from their Shift-modified variants.
        if (e.shiftKey !== variant.parsed.shift) return false;
        if (variant.exactKeys && !variant.exactKeys.includes(e.key)) {
          return matchesAltDigitByCode(e, variant.parsed);
        }
        return matchesKeyboardEvent(e, variant.parsed) || matchesAltDigitByCode(e, variant.parsed);
      });
      if (matches) callbackRef.current(e);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
    // shortcutKey is a stable join of the combo list, so the effect re-runs
    // only when the registered combos actually change.
  }, [shortcutKey]);
}
