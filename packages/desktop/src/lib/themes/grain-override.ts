import { clamp } from "@/lib/math";
import type { ThemeGrain, ThemeTexture } from "./chrome";
import type { ThemeAppearance } from "./types";
import { FROST_GRAIN, FROST_TEXTURE_MATERIAL } from "./texture-material";

/** Requested grain strength; the fallback is calibrated to Frost's material. */
export const GRAIN_OPACITY_RANGE = { min: 0, max: 1, step: 0.01 } as const;

/**
 * Frost's own grain color and tile size. Match its additive speckle on dark
 * fields and its multiplied paper texture on light fields, rather than using
 * the text color (nearly white/black) as a normal overlay.
 */
export function grainOpacity(texture: ThemeTexture, selected?: number): number {
  return clamp(
    selected ?? texture.grain?.opacity ?? 0,
    GRAIN_OPACITY_RANGE.min,
    GRAIN_OPACITY_RANGE.max,
  );
}

/** Preserve authored grain; added grain follows the theme's light/dark material. */
export function resolveTextureGrain(
  texture: ThemeTexture,
  selected: number | undefined,
  appearance: ThemeAppearance,
): ThemeGrain | null {
  if (selected === undefined) return texture.grain;
  const opacity = grainOpacity(texture, selected);
  if (opacity === 0) return null;
  if (texture.grain?.opacity === opacity) return texture.grain;
  if (texture.grain) return { ...texture.grain, opacity };
  return {
    ...FROST_GRAIN,
    blend: appearance === "dark" ? "screen" : "multiply",
    // Added fields now have the actual veil. Only textures without one need
    // equivalent attenuation here, so grain is never dimmed twice.
    opacity: opacity * (texture.veil ? 1 : 1 - FROST_TEXTURE_MATERIAL[appearance].veilOpacity),
  };
}
