import { DEFAULT_THEME_ID, getTheme, parseThemeId } from "./registry";
import { injectThemeCssVars } from "./inject";
import { chromeOf, type ThemeChrome } from "./chrome";
import { overrideTextureBase, usesFallbackTexture } from "./halo-composition";
import type { HaloOverride } from "./halo-override";
import type { ThemeDefinition, ThemeId } from "./types";
import { FROST_TEXTURE_MATERIAL } from "./texture-material";
import {
  isFollowSystemThemeEnabled,
  readBrowserSystemAppearance,
  resolveActiveThemeId,
} from "./system";

/**
 * Theme bootstrap helpers.
 *
 * The active theme is encoded as `<html data-theme="<id>">`. CSS variables and
 * Tailwind's semantic tokens key off this attribute, so changing it instantly
 * re-skins the entire UI (CodeMirror's theme rules, app chrome, etc.).
 *
 * Themes that carry their tokens as data (every user theme, plus the ported
 * first-party ones) additionally have those values injected as a CSS rule for
 * the same selector — see `inject.ts`.
 *
 * `data-appearance` mirrors the theme's light/dark classification so chrome
 * that can't rely on Tailwind's media-query `dark:` variant (e.g. mono logos)
 * can invert correctly for Cadencr themes.
 *
 * The xterm.js terminal is canvas-rendered and can't read CSS — it has its
 * own bridge in the terminal components that listens to the same setting.
 */

const STORAGE_KEY = "cadencr.theme";
const FOLLOW_SYSTEM_STORAGE_KEY = "cadencr.theme.followSystem";
const SYSTEM_LIGHT_STORAGE_KEY = "cadencr.theme.systemLight";
const SYSTEM_DARK_STORAGE_KEY = "cadencr.theme.systemDark";

/**
 * Sets the document's active theme attribute and injects the theme's token
 * values when it carries them as data. Idempotent.
 *
 * The injection happens *before* the attribute flips so the rule is already in
 * the stylesheet when the selector starts matching — otherwise a data-carried
 * theme would paint one frame with no tokens at all.
 */
export function applyThemeToDocument(themeId: ThemeId): void {
  if (typeof document === "undefined") return;
  // A user theme that was deleted, disabled or failed validation is not
  // applicable; resolving through `parseThemeId` (rather than setting an
  // attribute nothing styles) keeps a bad theme file from leaving the UI
  // unpainted.
  const theme = getTheme(parseThemeId(themeId));
  injectThemeCssVars(theme);
  document.documentElement.dataset.theme = theme.id;
  document.documentElement.dataset.appearance = theme.appearance;
  applyThemeChrome(theme);
}

/**
 * Publish the theme's chassis and tab style as attributes the stylesheets key
 * off, and the texture's base color as the one custom property that has to be
 * on `<html>` itself (the backdrop root must be opaque for `backdrop-filter`
 * to paint — see `theme-frost.css`). The texture's *layers* are rendered by
 * `<AmbientBackground/>`, which reads the same theme.
 */
function applyThemeChrome(theme: ThemeDefinition): void {
  const root = document.documentElement;
  const chrome: ThemeChrome = chromeOf(theme);
  root.dataset.chassis = chrome.chassis;
  root.dataset.tabs = chrome.tabs;

  // Published only when the texture declares an opaque base, not whenever it
  // paints something: taking over the backdrop root is safe only when there is
  // a color to put there. Keyed on "has a texture at all", a texture of halos
  // alone would strip the page background from both `<html>` and `<body>` and
  // leave the canvas showing through as the browser default white.
  const { base } = chrome.texture;
  applyTextureBase(base);
}

/**
 * Called after the theme is applied, from the same document-sync hook.
 * Texture activation changes this material; previews do not re-inject tokens.
 */
export function applyHaloAppearance(
  theme: ThemeDefinition,
  selection: Pick<HaloOverride, "enabled" | "grainOpacity">,
): void {
  if (typeof document === "undefined") return;
  const texture = chromeOf(theme).texture;
  const root = document.documentElement;
  const fallback = usesFallbackTexture(texture, selection);
  applyTextureBase(overrideTextureBase(texture, selection));
  root.toggleAttribute("data-halo-fallback", fallback);
  if (fallback) {
    const opacity = String(FROST_TEXTURE_MATERIAL[theme.appearance].veilOpacity);
    if (root.style.getPropertyValue("--ambient-veil-opacity") !== opacity) {
      root.style.setProperty("--ambient-veil-opacity", opacity);
    }
  } else {
    root.style.removeProperty("--ambient-veil-opacity");
  }
}

function applyTextureBase(base: string | null): void {
  const root = document.documentElement;
  if (base === null) {
    if (root.style.getPropertyValue("--ambient-base")) root.style.removeProperty("--ambient-base");
    if (root.dataset.textureBase !== undefined) delete root.dataset.textureBase;
  } else {
    if (root.style.getPropertyValue("--ambient-base") !== base) {
      root.style.setProperty("--ambient-base", base);
    }
    if (root.dataset.textureBase !== "on") root.dataset.textureBase = "on";
  }
}

/**
 * Read the cached theme id from localStorage. Used pre-paint in main.tsx to
 * apply the user's last-known theme synchronously, before React mounts and
 * before the workspace settings round-trip resolves. Server-side persisted
 * setting remains the source of truth — this cache is a paint hint only.
 */
export function readPersistedTheme(): ThemeId {
  if (typeof window === "undefined") return DEFAULT_THEME_ID;
  try {
    return resolveActiveThemeId({
      followSystem: isFollowSystemThemeEnabled(
        window.localStorage.getItem(FOLLOW_SYSTEM_STORAGE_KEY),
      ),
      manualTheme: window.localStorage.getItem(STORAGE_KEY),
      systemLightTheme: window.localStorage.getItem(SYSTEM_LIGHT_STORAGE_KEY),
      systemDarkTheme: window.localStorage.getItem(SYSTEM_DARK_STORAGE_KEY),
      systemAppearance: readCachedSystemAppearance(),
    });
  } catch {
    // localStorage may throw in some sandboxed environments. Fall back silently.
    return DEFAULT_THEME_ID;
  }
}

interface PersistedThemeSettings {
  followSystem: boolean;
  manualTheme: ThemeId;
  systemLightTheme: ThemeId;
  systemDarkTheme: ThemeId;
}

export function writePersistedThemeSettings(settings: PersistedThemeSettings): void {
  if (typeof window === "undefined") return;
  try {
    writeStorageValue(FOLLOW_SYSTEM_STORAGE_KEY, String(settings.followSystem));
    writeStorageValue(STORAGE_KEY, settings.manualTheme);
    writeStorageValue(SYSTEM_LIGHT_STORAGE_KEY, settings.systemLightTheme);
    writeStorageValue(SYSTEM_DARK_STORAGE_KEY, settings.systemDarkTheme);
  } catch {
    // Same: ignore localStorage failures.
  }
}

function writeStorageValue(key: string, value: string): void {
  if (window.localStorage.getItem(key) === value) return;
  window.localStorage.setItem(key, value);
}

function readCachedSystemAppearance(): "light" | "dark" {
  return readBrowserSystemAppearance();
}
