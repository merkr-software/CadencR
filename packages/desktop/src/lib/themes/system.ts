import { DEFAULT_THEME_ID, isThemeId } from "./registry";
import type { ThemeAppearance, ThemeId } from "./types";

export const THEME_SETTING_KEY = "theme_current";
export const THEME_FOLLOW_SYSTEM_SETTING_KEY = "theme_follow_system";
export const THEME_SYSTEM_LIGHT_SETTING_KEY = "theme_system_light";
export const THEME_SYSTEM_DARK_SETTING_KEY = "theme_system_dark";
/** JSON array of user-theme ids the user hid from the picker. */
export const THEME_USER_DISABLED_SETTING_KEY = "theme_user_disabled";
/**
 * JSON object of per-theme halo tuning, keyed by theme id. Kept beside the
 * theme rather than in it: the Frost pair are built-ins with no file, a
 * `managed:` theme is replaced on update, and a user theme's `theme.json` is a
 * file the user is editing. See `halo-override.ts`.
 */
export const THEME_HALO_OVERRIDES_SETTING_KEY = "theme_halo_overrides";

export const DEFAULT_SYSTEM_LIGHT_THEME_ID: ThemeId = "cadencr-light";
export const DEFAULT_SYSTEM_DARK_THEME_ID: ThemeId = DEFAULT_THEME_ID;
export const DEFAULT_SYSTEM_APPEARANCE: ThemeAppearance = "dark";
export const SYSTEM_DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

export interface ResolveActiveThemeOptions {
  followSystem: boolean;
  manualTheme: unknown;
  systemLightTheme: unknown;
  systemDarkTheme: unknown;
  systemAppearance: unknown;
}

export function isFollowSystemThemeEnabled(value: unknown): boolean {
  return value === "true";
}

export function parseSystemAppearance(value: unknown): ThemeAppearance {
  return value === "light" || value === "dark" ? value : DEFAULT_SYSTEM_APPEARANCE;
}

export function parseSystemLightThemeId(value: unknown): ThemeId {
  return isThemeId(value) ? value : DEFAULT_SYSTEM_LIGHT_THEME_ID;
}

export function parseSystemDarkThemeId(value: unknown): ThemeId {
  return isThemeId(value) ? value : DEFAULT_SYSTEM_DARK_THEME_ID;
}

export function readBrowserSystemAppearance(): ThemeAppearance {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return DEFAULT_SYSTEM_APPEARANCE;
  }
  return window.matchMedia(SYSTEM_DARK_MEDIA_QUERY).matches ? "dark" : "light";
}

export function resolveActiveThemeId(options: ResolveActiveThemeOptions): ThemeId {
  if (!options.followSystem) {
    return isThemeId(options.manualTheme) ? options.manualTheme : DEFAULT_THEME_ID;
  }

  const appearance = parseSystemAppearance(options.systemAppearance);
  if (appearance === "light") return parseSystemLightThemeId(options.systemLightTheme);
  return parseSystemDarkThemeId(options.systemDarkTheme);
}
