import type { ThemeDefinition } from "./types";
import { CADENCR_THEME_LOGOS } from "./logos";

/**
 * Carbon Owl — the authentic IBM-Carbon-inspired dark theme by pXius: graphite
 * chrome (`#141519` panels, `#1b1d22` editor) with gold/blue/green/purple syntax
 * on one coherent graphite surface. It pairs that palette with a square
 * geometry: a tight 4px `--radius` and a defined border (see
 * `theme-square.css` under `:root[data-theme="carbon-owl"]`) so panels read as
 * crisp, lightly-rounded blocks rather than soft cards.
 *
 * This module carries the xterm palette (canvas-rendered, can't read CSS
 * variables) plus a swatch for the settings picker; the CSS custom properties
 * live in `theme-square.css`. The terminal colors below are sampled directly
 * from the source theme's `terminal.*` / `terminal.ansi*` keys.
 */
export const CARBON_OWL_THEME: ThemeDefinition = {
  id: "carbon-owl",
  label: "Carbon Owl",
  appearance: "dark",
  logo: CADENCR_THEME_LOGOS.dark,
  swatch: {
    background: "#1b1d22",
    foreground: "#bbbbbb",
    primary: "#3398db",
    accent: "#d39e17",
  },
  xterm: {
    // Carbon Owl's source theme sets a purple terminal.background (#261b37), but
    // that eggplant clashes with Cadencr's graphite shell, so the terminal sits
    // on the same graphite surface as the editor/panels (#1b1d22) for one
    // coherent family. ANSI values stay the source theme's terminal.ansi* set.
    background: "#1b1d22",
    foreground: "#c8ccd2",
    cursor: "#d39e17",
    cursorAccent: "#1b1d22",
    selectionBackground: "#353d49",
    selectionForeground: "#c8ccd2",
    selectionInactiveBackground: "#2a2e35",
    black: "#370067",
    red: "#bf8b56",
    green: "#07d258",
    yellow: "#e3b625",
    blue: "#bd1c98",
    magenta: "#bf568b",
    cyan: "#2f7ecd",
    white: "#ffffff",
    brightBlack: "#627e99",
    brightRed: "#bf8b56",
    brightGreen: "#24966e",
    brightYellow: "#bfa656",
    brightBlue: "#8b56bf",
    brightMagenta: "#bf568b",
    brightCyan: "#20bcff",
    brightWhite: "#ffffff",
  },
};
