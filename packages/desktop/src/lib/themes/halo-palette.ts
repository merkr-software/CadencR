import { THEME_TOKEN_KEYS } from "./tokens";

/**
 * The tokens a halo can be recolored from.
 *
 * Derived from the theme vocabulary rather than listed by hand: every theme
 * already declares a vibrant accent set and a categorical chart set, so a halo
 * recolored from here lands in the theme's idiom instead of fighting it.
 * Catppuccin Frost gets Catppuccin colors for free, and an accent added to
 * `tokens.ts` later reaches the palette without a second edit.
 *
 * `--acc-comment` is left out — it is the muted grey for code comments, and a
 * halo painted in it reads as a dead one. `--chart-6` is optional and absent
 * from themes published before it existed, so it would contribute an empty
 * swatch.
 */
const PALETTE_TOKENS = THEME_TOKEN_KEYS.filter(
  (key) => key.startsWith("--chart-") || (key.startsWith("--acc-") && key !== "--acc-comment"),
);

export interface HaloPaletteEntry {
  /** The token the color came from — the swatch's accessible name. */
  token: string;
  /** A CSS color value, ready to paint. */
  color: string;
}

/**
 * The palette as the document currently resolves it.
 *
 * The active theme is already on `<html>`, so the computed values are the ones
 * on screen — no attribute flip, and no second copy of the token table. A token
 * that resolves to nothing is dropped rather than rendered as a blank swatch.
 */
export function readHaloPalette(root: HTMLElement): HaloPaletteEntry[] {
  const computed = window.getComputedStyle(root);
  return PALETTE_TOKENS.flatMap((token) => {
    const color = computed.getPropertyValue(token).trim();
    return color === "" ? [] : [{ token, color }];
  });
}
