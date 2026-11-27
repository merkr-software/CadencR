import type { ThemeDefinition } from "./types";
import { CADENCR_THEME_LOGOS } from "./logos";
import { frostTexture } from "./frost-texture";
import { FROST_GRAIN, FROST_TEXTURE_MATERIAL } from "./texture-material";

const MATERIAL = FROST_TEXTURE_MATERIAL.dark;

/**
 * Frost Dark — a luminous glassmorphic dark theme: translucent frosted panels
 * floating over a slow-drifting field of icy-azure halos. The glass mechanics
 * (translucent surfaces, backdrop blur, ambient field) live in
 * `theme-frost.css` under `:root[data-theme="frost-dark"]`; this module carries
 * the xterm palette (canvas-rendered, can't read CSS variables and can't be
 * translucent) plus a swatch for the settings picker.
 *
 * The xterm background stays a SOLID cold tone — the live terminal can't blur a
 * backdrop, so a translucent value would just look muddy over the halos.
 */
export const FROST_DARK_THEME: ThemeDefinition = {
  id: "frost-dark",
  label: "Frost Dark",
  appearance: "dark",
  logo: CADENCR_THEME_LOGOS.dark,
  chrome: {
    chassis: "flat",
    tabs: "underline",
    // A fine cool-white speckle that `screen` adds onto the dark field.
    texture: frostTexture({
      base: "oklch(0.165 0.018 262)",
      halos: [
        `oklch(0.6 0.12 230 / ${MATERIAL.haloAlphas[0]})`,
        `oklch(0.56 0.11 285 / ${MATERIAL.haloAlphas[1]})`,
        `oklch(0.62 0.1 200 / ${MATERIAL.haloAlphas[2]})`,
      ],
      haloOpacity: MATERIAL.haloOpacity,
      grain: { color: FROST_GRAIN.color, opacity: 0.36, blend: "screen" },
    }),
  },
  swatch: {
    background: "#141826",
    foreground: "#e6edf6",
    primary: "#5fb3e0",
    accent: "#7fd6e8",
  },
  xterm: {
    // Solid fallback. In the Frost themes the live `.xterm-viewport` is forced
    // transparent via CSS (see theme-frost.css) so the frosted terminal panel
    // (`--terminal-bg`) and the ambient gradient show through; xterm's DOM
    // renderer composites a themed background onto black, so a transparent
    // value here would just collapse to black instead.
    background: "#141826",
    foreground: "#e6edf6",
    cursor: "#5fb3e0",
    cursorAccent: "#141826",
    selectionBackground: "#2a3550",
    selectionForeground: "#e6edf6",
    selectionInactiveBackground: "#222b42",
    black: "#1a1f2e",
    red: "#ff7a85",
    green: "#6fe0a8",
    yellow: "#f2d98a",
    blue: "#6cb6ff",
    magenta: "#c8a6ff",
    cyan: "#7fd6e8",
    white: "#c9d4e3",
    brightBlack: "#5a6582",
    brightRed: "#ff97a0",
    brightGreen: "#90e9bd",
    brightYellow: "#f7e6a8",
    brightBlue: "#8ec8ff",
    brightMagenta: "#d7bdff",
    brightCyan: "#a3e4f0",
    brightWhite: "#f3f7fc",
  },
};
