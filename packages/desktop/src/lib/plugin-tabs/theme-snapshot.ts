import type { ThemeSnapshot } from "@cadencr/tab-sdk/protocol";

import { cssColorToHex } from "@/lib/css-color";
import { THEME_OPTIONAL_TOKEN_KEYS, THEME_TOKEN_KEYS } from "@/lib/themes/tokens";

const TOKEN_KEYS: readonly string[] = [...THEME_TOKEN_KEYS, ...THEME_OPTIONAL_TOKEN_KEYS];

/**
 * The live theme as guests see it (§7 `ThemeSnapshot`): the computed value of
 * every theme token on `<html>`, names without the leading `--`. Read from
 * the document rather than the theme registry so it is exactly what the app
 * paints — family overrides (Frost, square themes) and user themes included.
 */
export function readThemeSnapshot(root: HTMLElement = document.documentElement): ThemeSnapshot {
  const style = getComputedStyle(root);
  const tokens: Record<string, string> = {};
  for (const key of TOKEN_KEYS) {
    const value = style.getPropertyValue(key).trim();
    if (value !== "") tokens[key.slice(2)] = value;
  }
  return {
    id: root.dataset.theme ?? "",
    appearance: root.dataset.appearance === "light" ? "light" : "dark",
    tokens,
  };
}

/**
 * `value` as an opaque `#rrggbb` Electron accepts for a view background.
 * Theme tokens may be `oklch()` or translucent (Frost), which
 * `setBackgroundColor` rejects or renders see-through: paint the color over
 * the appearance's base on a 1×1 canvas and read the pixel back. Falls back
 * to the raw value where no canvas exists (tests).
 */
export function opaqueBackground(value: string, appearance: ThemeSnapshot["appearance"]): string {
  const base = appearance === "light" ? "#ffffff" : "#000000";
  if (value === "") return base;
  return cssColorToHex(value, base) ?? value;
}
