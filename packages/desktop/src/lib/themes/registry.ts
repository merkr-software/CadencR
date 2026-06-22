import { AURORA_THEME } from "./aurora";
import { CARBON_OWL_THEME } from "./carbon-owl";
import { DRACULA_THEME } from "./dracula";
import { FROST_DARK_THEME } from "./frost-dark";
import { FROST_LIGHT_THEME } from "./frost-light";
import { MONOKAI_THEME } from "./monokai";
import { MONOKAI_LIGHT_THEME } from "./monokai-light";
import { ONE_DARK_THEME } from "./one-dark";
import { ONE_LIGHT_THEME } from "./one-light";
import { PAPER_OWL_THEME } from "./paper-owl";
import { THEME_IDS, type ThemeDefinition, type ThemeId } from "./types";

/** Display order in the settings picker. */
export const THEME_LIST: ThemeDefinition[] = [
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
];

/** All themes shipped with Cadencr, keyed by id. */
export const THEMES: Record<ThemeId, ThemeDefinition> = {
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
};

export const DEFAULT_THEME_ID: ThemeId = "dracula";

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && (THEME_IDS as readonly string[]).includes(value);
}

export function parseThemeId(value: unknown): ThemeId {
  return isThemeId(value) ? value : DEFAULT_THEME_ID;
}

export function getTheme(id: ThemeId): ThemeDefinition {
  return THEMES[id];
}
