/**
 * Theme system primitives.
 *
 * A theme bundles three flavors of color data:
 * 1. CSS variables consumed by Tailwind / index.css. A theme may carry these as
 *    *data* (`cssVars`, injected at runtime by `applyThemeToDocument`) or leave
 *    them authored as plain CSS rules under a `:root[data-theme="<id>"]` block.
 *    Both paths end up as the same custom properties on `<html>`; the data path
 *    is what makes user-authored themes possible.
 * 2. An xterm.js ITheme palette (canvas-rendered; can't read CSS variables).
 * 3. A label for the settings picker.
 *
 * CodeMirror uses CSS variables directly (its EditorView.theme rules become CSS
 * and inherit `var(--…)`), so there's no per-theme CodeMirror palette here —
 * the editor follows `data-theme` on the document automatically.
 */

import type { ThemeChrome } from "./chrome";
import type { ThemeCssVars } from "./tokens";

/** Built-in themes shipped with the app. User themes carry a `user:` id. */
export const THEME_IDS = [
  "cadencr-dark",
  "cadencr-light",
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
  "catppuccin-mocha",
  "catppuccin-latte",
] as const;
export type BuiltInThemeId = (typeof THEME_IDS)[number];

/**
 * A user-authored theme's id, namespaced so it can never collide with a
 * built-in and so `data-theme` selectors in the stylesheets (which all target
 * bare built-in ids) never accidentally match one.
 */
export type UserThemeId = `user:${string}`;
export type ManagedThemeId = `managed:${string}`;

/** Any theme the app can apply: built-in or user-authored. */
export type ThemeId = BuiltInThemeId | UserThemeId | ManagedThemeId;

export const USER_THEME_ID_PREFIX = "user:";

export function isUserThemeId(id: string): id is UserThemeId {
  return id.startsWith(USER_THEME_ID_PREFIX);
}

export function isManagedThemeId(id: string): id is ManagedThemeId {
  return id.startsWith("managed:");
}

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
  /**
   * Token values carried as data. When present they are injected on apply and
   * are the theme's only source of tokens; when absent the theme's values come
   * from a `:root[data-theme="<id>"]` block in one of the theme stylesheets.
   * Every user theme sets this; first-party themes are being ported over.
   */
  cssVars?: ThemeCssVars;
  /**
   * Chassis, tabs and background texture — the shape of the theme rather than
   * its palette (see `chrome.ts`). Absent means the plain default every theme
   * but the CadencR and Frost pairs has always had; read it through
   * `chromeOf()` rather than dereferencing it.
   */
  chrome?: ThemeChrome;
  /**
   * Texture asset file name → `data:` URL, as read from the theme's own folder
   * by the backend. Only user themes have any; a `chrome.texture.image` whose
   * file is missing never gets this far, because that is a validation failure.
   */
  assets?: Record<string, string>;
  /** Used by the settings picker to render a small swatch preview. */
  swatch: {
    background: string;
    foreground: string;
    primary: string;
    accent: string;
  };
  xterm: XTermPalette;
}
