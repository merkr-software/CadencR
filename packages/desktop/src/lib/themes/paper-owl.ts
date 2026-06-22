import type { ThemeDefinition } from "./types";
import { CADENCR_THEME_LOGOS } from "./logos";

/**
 * Paper Owl — a square, editorial light theme: warm paper surfaces
 * (`#f7f4ec`) framed by defined `#d8cfbd` borders, with Night Owl Light's cool
 * slate text (`#403f53`) and deepened ink-blue / teal / plum syntax accents.
 * Like its dark sibling Carbon Owl, the geometry carries the identity — it
 * zeroes `--radius` and uses a 2px `--border-width` (see `theme-square.css`
 * under `:root[data-theme="paper-owl"]`) so panels read as crisp, letterpress
 * frames rather than soft rounded cards.
 *
 * This module carries the xterm palette (canvas-rendered, can't read CSS
 * variables) plus a swatch for the settings picker; the CSS custom properties
 * live in `theme-square.css`.
 */
export const PAPER_OWL_THEME: ThemeDefinition = {
  id: "paper-owl",
  label: "Paper Owl",
  appearance: "light",
  logo: CADENCR_THEME_LOGOS.light,
  swatch: {
    background: "#f7f4ec",
    foreground: "#403f53",
    primary: "#4876d6",
    accent: "#0c969b",
  },
  xterm: {
    background: "#f7f4ec",
    foreground: "#403f53",
    cursor: "#4876d6",
    cursorAccent: "#f7f4ec",
    selectionBackground: "#d3e8f8",
    selectionForeground: "#403f53",
    selectionInactiveBackground: "#e3ecf5",
    // Light-theme ANSI follows the One Light convention: `black` is the darkest
    // ink, `white` a light gray, `brightWhite` the darkest tone again.
    black: "#403f53",
    red: "#d3423e",
    green: "#08916a",
    yellow: "#a07e00",
    blue: "#4876d6",
    magenta: "#aa0982",
    cyan: "#0c969b",
    white: "#b8bccb",
    brightBlack: "#6b6f80",
    brightRed: "#c96765",
    brightGreen: "#2aa298",
    brightYellow: "#daaa01",
    brightBlue: "#5ca7e4",
    brightMagenta: "#994cc3",
    brightCyan: "#2aa298",
    brightWhite: "#403f53",
  },
};
