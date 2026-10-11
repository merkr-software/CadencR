import { AURORA_THEME } from "./aurora";
import { CADENCR_DARK_THEME } from "./cadencr-dark";
import { CADENCR_LIGHT_THEME } from "./cadencr-light";
import { CARBON_OWL_THEME } from "./carbon-owl";
import { CATPPUCCIN_LATTE_THEME } from "./catppuccin-latte";
import { CATPPUCCIN_MOCHA_THEME } from "./catppuccin-mocha";
import { DRACULA_THEME } from "./dracula";
import { FROST_DARK_THEME } from "./frost-dark";
import { FROST_LIGHT_THEME } from "./frost-light";
import { MONOKAI_THEME } from "./monokai";
import { MONOKAI_LIGHT_THEME } from "./monokai-light";
import { ONE_DARK_THEME } from "./one-dark";
import { ONE_LIGHT_THEME } from "./one-light";
import { PAPER_OWL_THEME } from "./paper-owl";
import { getUserTheme, listUserThemes } from "./user-registry";
import {
  THEME_IDS,
  isUserThemeId,
  isManagedThemeId,
  type BuiltInThemeId,
  type ThemeDefinition,
  type ThemeId,
} from "./types";

/** Display order in the settings picker. */
export const THEME_LIST: ThemeDefinition[] = [
  CADENCR_DARK_THEME,
  CADENCR_LIGHT_THEME,
  DRACULA_THEME,
  AURORA_THEME,
  ONE_DARK_THEME,
  ONE_LIGHT_THEME,
  MONOKAI_THEME,
  MONOKAI_LIGHT_THEME,
  FROST_DARK_THEME,
  FROST_LIGHT_THEME,
  CARBON_OWL_THEME,
  PAPER_OWL_THEME,
  CATPPUCCIN_MOCHA_THEME,
  CATPPUCCIN_LATTE_THEME,
];

/** All themes shipped with Cadencr, keyed by id. */
export const THEMES: Record<BuiltInThemeId, ThemeDefinition> = {
  "cadencr-dark": CADENCR_DARK_THEME,
  "cadencr-light": CADENCR_LIGHT_THEME,
  dracula: DRACULA_THEME,
  aurora: AURORA_THEME,
  "one-dark": ONE_DARK_THEME,
  "one-light": ONE_LIGHT_THEME,
  monokai: MONOKAI_THEME,
  "monokai-light": MONOKAI_LIGHT_THEME,
  "frost-dark": FROST_DARK_THEME,
  "frost-light": FROST_LIGHT_THEME,
  "carbon-owl": CARBON_OWL_THEME,
  "paper-owl": PAPER_OWL_THEME,
  "catppuccin-mocha": CATPPUCCIN_MOCHA_THEME,
  "catppuccin-latte": CATPPUCCIN_LATTE_THEME,
};

export const DEFAULT_THEME_ID: BuiltInThemeId = "cadencr-dark";

export function isBuiltInThemeId(value: unknown): value is BuiltInThemeId {
  return typeof value === "string" && (THEME_IDS as readonly string[]).includes(value);
}

/**
 * Whether `value` names a theme the app can actually apply right now — a
 * built-in, or a user theme that is registered (i.e. it exists on disk and
 * passed validation). A `user:` id whose file was deleted or broken is
 * deliberately *not* a theme id, so the caller falls back to the default
 * instead of applying nothing and leaving the UI unstyled.
 */
export function isThemeId(value: unknown): value is ThemeId {
  if (typeof value !== "string") return false;
  return (
    isBuiltInThemeId(value) ||
    ((isUserThemeId(value) || isManagedThemeId(value)) && getUserTheme(value) !== undefined)
  );
}

export function parseThemeId(value: unknown): ThemeId {
  return isThemeId(value) ? value : DEFAULT_THEME_ID;
}

export function getTheme(id: ThemeId): ThemeDefinition {
  if (isUserThemeId(id) || isManagedThemeId(id))
    return getUserTheme(id) ?? THEMES[DEFAULT_THEME_ID];
  return THEMES[id];
}

/** Built-ins followed by the registered user themes, in gallery order. */
export function allThemes(): ThemeDefinition[] {
  return [...THEME_LIST, ...listUserThemes()];
}
