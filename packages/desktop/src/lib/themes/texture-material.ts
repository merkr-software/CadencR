/**
 * Shared strength of Frost's material and user-added halo fields.
 *
 * Intensity multiplies the layer opacity; veil strength separately multiplies
 * the page tint. Their defaults give the slider the same
 * response for authored Frost halos and halos added to another palette.
 * Veil opacity mirrors the page tokens in theme-frost.css.
 */
/** Centers in viewport percent, sizes in vw, drift periods in seconds. */
export const FROST_HALO_LAYOUT = [
  { size: 72, x: 28, y: 32, drift: 28 },
  { size: 66, x: 79, y: 61, drift: 36 },
  { size: 62, x: 49, y: 86, drift: 42 },
] as const;

export const FROST_HALO_BLUR = 80;
export const FROST_GRAIN = { color: "oklch(0.72 0.03 265)", scale: 180 } as const;

export const FROST_TEXTURE_MATERIAL = {
  dark: {
    haloOpacity: 0.56,
    haloAlphas: [0.55, 0.46, 0.46],
    veilOpacity: 0.55,
  },
  light: {
    haloOpacity: 0.68,
    haloAlphas: [0.7, 0.6, 0.6],
    veilOpacity: 0.5,
  },
} as const;
