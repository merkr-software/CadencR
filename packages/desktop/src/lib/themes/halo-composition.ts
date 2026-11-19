import { clamp } from "@/lib/math";
import type { ThemeHalo, ThemeTexture } from "./chrome";
import type { HaloOverride } from "./halo-override";
import { FROST_HALO_BLUR, FROST_HALO_LAYOUT, FROST_TEXTURE_MATERIAL } from "./texture-material";
import type { ThemeAppearance } from "./types";

/** User compositions are bounded even when a setting is edited by hand. */
export const MAX_HALOS = 10;
export const DEFAULT_HALO_COUNT = 3;

/**
 * A theme's background without its alpha. Keeping the root opaque is necessary
 * for backdrop-filter, while the surfaces above it can let the field through.
 * This remains a CSS expression so palette changes need no document reads.
 */
const FALLBACK_BASE = "oklch(from var(--background) l c h)";

// Slots keep their geometry and palette token when another halo is added or
// removed. The first three form a broad field; later ones fill its quiet areas.
const HALO_POSITIONS = [
  ...FROST_HALO_LAYOUT.map(({ x, y }) => [x, y] as const),
  [72, 18],
  [18, 72],
  [48, 48],
  [88, 84],
  [12, 18],
  [52, 12],
  [28, 92],
] as const;

/** Stable layers with Frost's geometry and strength, carrying this theme's hues. */
function fallbackHalos(appearance: ThemeAppearance): ThemeHalo[] {
  const material = FROST_TEXTURE_MATERIAL[appearance];
  return HALO_POSITIONS.map(([x, y], index) => ({
    x,
    y,
    size: FROST_HALO_LAYOUT[index % FROST_HALO_LAYOUT.length].size,
    blur: FROST_HALO_BLUR,
    opacity: material.haloOpacity,
    drift: FROST_HALO_LAYOUT[index % FROST_HALO_LAYOUT.length].drift,
    color: `oklch(from var(--chart-${(index % 5) + 1}, var(--primary)) l c h / ${material.haloAlphas[index % 3]})`,
  }));
}

const FALLBACK_HALOS: Record<ThemeAppearance, ThemeHalo[]> = {
  dark: fallbackHalos("dark"),
  light: fallbackHalos("light"),
};

/** Missing activation preserves an authored field and leaves other themes off. */
export function halosEnabled(texture: ThemeTexture, enabled?: boolean): boolean {
  return enabled ?? texture.halos.length > 0;
}

export function haloCount(texture: ThemeTexture, count?: number): number {
  const requested = count ?? (texture.halos.length || DEFAULT_HALO_COUNT);
  return clamp(Math.round(requested), 1, MAX_HALOS);
}

/**
 * The source composition, before rotation, color and intensity. Authored slots
 * stay live with the theme; added slots come from the shared palette-based set.
 * Disabled fields still have a composition to show in the controls.
 */
export function halosFor(
  texture: ThemeTexture,
  count?: number,
  appearance: ThemeAppearance = "dark",
): ThemeHalo[] {
  const length = haloCount(texture, count);
  if (length === texture.halos.length) return texture.halos;
  if (length < texture.halos.length) return texture.halos.slice(0, length);
  return [...texture.halos, ...FALLBACK_HALOS[appearance].slice(texture.halos.length, length)];
}

/** Added halos or grain need surfaces that let their texture show through. */
export function usesFallbackTexture(
  texture: ThemeTexture,
  selection: Pick<HaloOverride, "enabled" | "grainOpacity">,
): boolean {
  return (
    texture.halos.length === 0 &&
    (halosEnabled(texture, selection.enabled) ||
      (texture.grain === null && (selection.grainOpacity ?? 0) > 0))
  );
}

export function overrideTextureBase(
  texture: ThemeTexture,
  selection: Pick<HaloOverride, "enabled" | "grainOpacity">,
): string | null {
  return usesFallbackTexture(texture, selection) ? (texture.base ?? FALLBACK_BASE) : texture.base;
}
