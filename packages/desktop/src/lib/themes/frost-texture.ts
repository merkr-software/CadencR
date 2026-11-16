import type { ThemeBlend, ThemeTexture } from "./chrome";
import { FROST_GRAIN, FROST_HALO_BLUR, FROST_HALO_LAYOUT } from "./texture-material";

/**
 * The Frost field, as data.
 *
 * Three big drifting halos and a film of grain over a flat cold base — the
 * texture that used to be hardcoded in `theme-frost.css` against
 * `data-theme="frost-*"`, which is why a theme duplicated from Frost arrived
 * with the palette and a blank background behind it.
 *
 * Both variants share the geometry and differ only in color and strength, so
 * the layout lives here once. A user theme is free to describe something else
 * entirely — this is the same closed vocabulary any theme file can use, not a
 * Frost-only path.
 */
interface FrostTextureOptions {
  /** Opaque field color. Also what makes `backdrop-filter` paint at all. */
  base: string;
  /** Halo colors, in drift order: the two upper fields and the lower one. */
  halos: [string, string, string];
  /** Strength of all three halos. */
  haloOpacity: number;
  grain: { color: string; opacity: number; blend: ThemeBlend };
}

/**
 * A wide, still bloom at the top of the window. The large calm areas (the agent
 * reading column) read as a lit field with depth rather than a flat slab.
 * Negligible on the bright Frost Light base, a subtle lift on Frost Dark.
 *
 * Unblurred, unlike the halos: at 140vw across, fading to transparent at 70% of
 * its own radius and carried at 5% opacity, it is already softer than any blur
 * radius would make it — and a `filter` here would cost a full-viewport
 * rasterization pass, on every window resize, for no visible difference.
 */
const TOP_GLOW = {
  color: "oklch(1 0 0)",
  size: 140,
  x: 50,
  y: 0,
  blur: 0,
  opacity: 0.05,
  drift: 0,
} as const;

export function frostTexture(options: FrostTextureOptions): ThemeTexture {
  return {
    base: options.base,
    halos: [
      TOP_GLOW,
      ...FROST_HALO_LAYOUT.map((layout, index) => ({
        ...layout,
        color: options.halos[index],
        blur: FROST_HALO_BLUR,
        opacity: options.haloOpacity,
      })),
    ],
    image: null,
    grain: { ...options.grain, scale: FROST_GRAIN.scale },
    // The halos and grain would otherwise wash out every surface above them;
    // the veil is what the translucent `body` background used to do.
    veil: true,
  };
}
