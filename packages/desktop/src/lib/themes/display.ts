import type { UiTranslator } from "@/lib/i18n/ui";
import { isBuiltInThemeId } from "./registry";
import type { BuiltInThemeId, ThemeAppearance, ThemeDefinition } from "./types";

const builtInLabels: Record<BuiltInThemeId, (t: UiTranslator) => string> = {
  "cadencr-dark": (t) => t("appearance.themes.cadencrDark", "CadencR Dark"),
  "cadencr-light": (t) => t("appearance.themes.cadencrLight", "CadencR Light"),
  dracula: (t) => t("appearance.themes.dracula", "Dracula"),
  aurora: (t) => t("appearance.themes.aurora", "Aurora"),
  "one-dark": (t) => t("appearance.themes.oneDark", "One Dark"),
  "one-light": (t) => t("appearance.themes.oneLight", "One Light"),
  monokai: (t) => t("appearance.themes.monokai", "Monokai"),
  "monokai-light": (t) => t("appearance.themes.monokaiLight", "Monokai Light"),
  "frost-dark": (t) => t("appearance.themes.frostDark", "Frost Dark"),
  "frost-light": (t) => t("appearance.themes.frostLight", "Frost Light"),
  "carbon-owl": (t) => t("appearance.themes.carbonOwl", "Carbon Owl"),
  "paper-owl": (t) => t("appearance.themes.paperOwl", "Paper Owl"),
  "catppuccin-mocha": (t) => t("appearance.themes.catppuccinMocha", "Catppuccin Mocha"),
  "catppuccin-latte": (t) => t("appearance.themes.catppuccinLatte", "Catppuccin Latte"),
};

/** Theme files and signed catalog labels are author data. */
export function themeDisplayLabel(theme: ThemeDefinition, t: UiTranslator): string {
  return isBuiltInThemeId(theme.id) ? builtInLabels[theme.id](t) : theme.label;
}

export function themeAppearanceLabel(appearance: ThemeAppearance, t: UiTranslator): string {
  return appearance === "dark"
    ? t("appearance.theme.dark", "dark")
    : t("appearance.theme.light", "light");
}
