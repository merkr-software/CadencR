/**
 * Theme system primitives.
 *
 * A theme bundles three flavors of color data:
 * 1. CSS variables consumed by Tailwind / index.css. These live in stylesheets,
 *    so the theme module only declares which IDs exist — the values are
 *    authored as plain CSS rules under `:root[data-theme="<id>"]` blocks.
 * 2. An xterm.js ITheme palette (canvas-rendered; can't read CSS variables).
 * 3. A label for the settings picker.
 *
 * CodeMirror uses CSS variables directly (its EditorView.theme rules become CSS
 * and inherit `var(--…)`), so there's no per-theme CodeMirror palette here —
 * the editor follows `data-theme` on the document automatically.
 */

export const THEME_IDS = [
  "dracula",
  "aurora",
  "one-dark",
  "one-light",
  "monokai",
  "monokai-light",
  "frost-dark",
  "frost-light",
  "carbon-owl",
  "paper-owl",
] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export type ThemeAppearance = "light" | "dark";
export type ThemeLogoVariant = "light" | "dark";

export interface ThemeLogo {
  src: string;
  alt: string;
  variant: ThemeLogoVariant;
  displayScale: number;
}

/**
 * xterm.js ITheme — duplicated locally to keep this module dependency-free
 * (we don't want types/themes to import @xterm/xterm just for the interface).
 */
export interface XTermPalette {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground: string;
  selectionInactiveBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface ThemeDefinition {
  id: ThemeId;
  label: string;
  /** Hint for CodeMirror's `{ dark }` flag. Light themes still get the
   *  Cadencr palette via CSS variables — this only switches CM's built-in
   *  fallback styling for things we don't override. */
  appearance: ThemeAppearance;
  /** Logo chosen by this theme. Light themes may still opt into a dark logo. */
  logo: ThemeLogo;
  /** Used by the settings picker to render a small swatch preview. */
  swatch: {
    background: string;
    foreground: string;
    primary: string;
    accent: string;
  };
  xterm: XTermPalette;
}
